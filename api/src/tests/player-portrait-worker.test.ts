import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { BatchGetItemCommand, GetItemCommand, QueryCommand, TransactWriteItemsCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { PlayerPortraitWorker } from '../data/player-portrait-worker.js';
import { profileWorkPartition, profileMediaWorkKey, profileMediaWorkReference } from '../data/player-profile-work.js';
import { portraitRetirementItem } from '../data/player-portrait-retirement.js';
import { historyHash, historyKey, historyRow, type HistoryItem } from '../data/player-history-model.js';
const at = '2026-10-04T00:00:00.000Z';
const key = (item: HistoryItem): string => JSON.stringify([item.pk!.S, item.sk!.S]);
const body = (item: HistoryItem): Record<string, any> => JSON.parse(item.data!.S!);
class MemoryClient {
  items = new Map<string, HistoryItem>();
  transactions: TransactWriteItem[][] = [];
  queries: QueryCommand['input'][] = [];
  beforeCommit: ((actions: TransactWriteItem[]) => void | Promise<void>) | null = null;
  loseAck: ((actions: TransactWriteItem[]) => boolean) | null = null;
  advanceCursor = false;
  seed(pk: string, sk: string, type: string, data: unknown) {
    const item = historyRow(pk, sk, type, data); this.items.set(key(item), item); return item;
  }
  read(pk: string, sk: string) { return this.items.get(key(historyKey(pk, sk))); }
  remove(pk: string, sk: string) { this.items.delete(key(historyKey(pk, sk))); }
  async send(command: unknown): Promise<unknown> {
    if (command instanceof BatchGetItemCommand) {
      const request = command.input.RequestItems!.table;
      assert.equal(request.ConsistentRead, true); assert(request.Keys!.length <= 100);
      return { Responses: { table: request.Keys!.flatMap(k => {
        const row = this.items.get(key(k)); return row ? [structuredClone(row)] : [];
      }) } };
    }
    if (command instanceof GetItemCommand) {
      assert.equal(command.input.ConsistentRead, true); assert(command.input.Key);
      return { Item: structuredClone(this.items.get(key(command.input.Key))) };
    }
    if (command instanceof QueryCommand) {
      const input = command.input; this.queries.push(structuredClone(input));
      assert.equal(input.ConsistentRead, true); assert.equal(input.IndexName, undefined);
      assert(input.Limit && input.Limit <= 100); assert.equal(input.FilterExpression, undefined);
      const values = input.ExpressionAttributeValues!, pk = values[':pk'].S!, prefix = values[':prefix'].S!;
      const start = input.ExclusiveStartKey?.sk?.S, ascending = input.ScanIndexForward !== false;
      const compare = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
      const candidates = [...this.items.values()].filter(item => item.pk.S === pk && item.sk.S!.startsWith(prefix)
        && (!start || (ascending ? compare(item.sk.S!, start) > 0 : compare(item.sk.S!, start) < 0)))
        .sort((a, b) => compare(a.sk.S!, b.sk.S!) * (ascending ? 1 : -1));
      const rows = candidates.slice(0, input.Limit), last = rows.at(-1);
      if (this.advanceCursor && last) return { Items: structuredClone(rows), LastEvaluatedKey: historyKey(pk, `${last.sk.S}z`) };
      return { Items: structuredClone(rows), ...(last && candidates.length > rows.length
        ? { LastEvaluatedKey: historyKey(pk, last.sk.S!) } : {}) };
    }
    assert(command instanceof TransactWriteItemsCommand, 'no scans, direct writes or unbounded alternate APIs');
    const actions = command.input.TransactItems!; this.transactions.push(structuredClone(actions));
    assert(actions.length <= 100); assert(Buffer.byteLength(JSON.stringify(actions)) <= 3_500_000);
    assert.equal(new Set(actions.map(action => key(action.Put?.Item ?? action.ConditionCheck!.Key!))).size, actions.length);
    if (this.beforeCommit) await this.beforeCommit(actions);
    const valid = actions.map(action => {
      const operation = action.Put ?? action.ConditionCheck!, target = action.Put?.Item ?? action.ConditionCheck!.Key;
      assert(target); const stored = this.items.get(key(target));
      const clause = (expression: string): boolean => {
        if (!expression) return true;
        const missing = expression.match(/^attribute_not_exists\((.+)\)$/);
        if (missing) return !stored?.[missing[1]];
        const equal = expression.match(/^(\S+) = (\S+)$/); assert(equal, expression);
        const field = operation.ExpressionAttributeNames?.[equal[1]] ?? equal[1];
        return JSON.stringify(stored?.[field]) === JSON.stringify(operation.ExpressionAttributeValues![equal[2]]);
      };
      return !operation.ConditionExpression || operation.ConditionExpression.split(' OR ').some(alternative =>
        alternative.split(' AND ').every(clause));
    });
    if (valid.some(value => !value)) throw Object.assign(new Error('conditional failure'), {
      name: 'TransactionCanceledException', CancellationReasons: valid.map(value => ({ Code: value ? 'None' : 'ConditionalCheckFailed' })) });
    for (const action of actions) if (action.Put) {
      assert(action.Put.Item); this.items.set(key(action.Put.Item), structuredClone(action.Put.Item));
    }
    if (this.loseAck?.(actions)) throw Object.assign(new Error('lost acknowledgement'), { name: 'TimeoutError' });
    return {};
  }
}

function fixture(status = 'uploading', referenced = false, playerId = 'player') {
  const client = new MemoryClient(), jobId = randomUUID(), ref = profileMediaWorkReference(playerId, jobId);
  const objectKey = `portraits/${historyHash(playerId)}/${jobId}.png`, deleted: string[] = [];
  client.seed('PLAYER_IDENTITY', 'CONTROL', 'playerIdentityControl', { mode: 'fenced', coverage: 'verified', epoch: 'e1', writerVersion: 1 });
  client.seed('PLAYER_HISTORY', 'CONTROL', 'playerHistoryReadiness', { version: 1, enabled: true, revision: randomUUID(), ruleVersion: 1,
    activatedAt: at, manifest: { version: 1, writerVersion: 1, writerSha: 'a'.repeat(40), tableName: 'table', accountId: '123456789012',
      region: 'ap-southeast-2', reviewedPlan: 'https://github.com/ajfisher/3fc/pull/210', drainedAt: at, ruleVersion: 1 } });
  client.seed(`PLAYER#${playerId}`, 'IDENTITY', 'playerIdentity', { playerId, rootId: playerId, members: [playerId],
    identityVersion: 1, writeVersion: 'w1', displayName: 'Name', formerNames: [] });
  const portrait = { jobId, objectKey, digest: 'a'.repeat(64), bytes: 123, contentType: 'image/png', width: 512, height: 512 };
  client.seed(`PLAYER#${playerId}`, 'PRESENTATION', 'playerPresentation', { version: 1, playerId, nameRevision: randomUUID(), portrait: referenced ? portrait : null });
  client.seed(profileWorkPartition(playerId), profileMediaWorkKey(jobId), 'playerProfileMediaWork', {
    version: 1, jobId, playerId, objectKey, digest: portrait.digest, bytes: portrait.bytes,
    status, notBefore: new Date(Date.parse(at) + (status === 'uploading' ? 120_000 : 0)).toISOString(), createdAt: at, updatedAt: at,
  });
  let current = at;
  const store = { delete: async (key: string) => { deleted.push(key); } };
  return { client, ref, portrait, store, deleted, playerId, worker: new PlayerPortraitWorker(client, 'table', store, () => current),
    advance: () => { current = new Date(Date.parse(at) + 121_000).toISOString(); } };
}
function alter(client: MemoryClient, pk: string, sk: string, fields: Record<string, unknown>) {
  const row = client.read(pk, sk)!; row.data = { S: JSON.stringify({ ...body(row), ...fields }) };
}
function state(f: ReturnType<typeof fixture>) { return body(f.client.read(profileWorkPartition(f.playerId), f.ref.key)!); }

test('uncommitted uploads wait their original lease then close publication before deleting', async () => {
  const f = fixture();
  assert.deepEqual(await f.worker.process(f.ref), { done: false, delaySeconds: 120 }); assert.deepEqual(f.deleted, []);
  f.advance(); assert.deepEqual(await f.worker.process(f.ref), { done: false }); assert.equal(state(f).status, 'deleting');
  assert.deepEqual(f.deleted, []); // No object deletion before a durable closed upload.
  assert.deepEqual(await f.worker.process(f.ref), { done: true }); assert.equal(state(f).status, 'deleted');
  assert.deepEqual(f.deleted, [f.portrait.objectKey]); await f.worker.process(f.ref); assert.equal(f.deleted.length, 1);
  assert(f.client.transactions.every(actions => actions.every(action => !action.Put?.Item?.pk.S?.startsWith('PLAYER#'))));
});

test('a referenced active portrait is never deleted and inconsistent pointers fail closed', async () => {
  const f = fixture('active', true); f.advance();
  assert.deepEqual(await f.worker.process(f.ref), { done: true }); assert.deepEqual(f.deleted, []);
  alter(f.client, profileWorkPartition(f.playerId), f.ref.key, { status: 'cleanup' });
  await assert.rejects(f.worker.process(f.ref)); assert.deepEqual(f.deleted, []);
  alter(f.client, profileWorkPartition(f.playerId), f.ref.key, { status: 'active', digest: 'b'.repeat(64) });
  await assert.rejects(f.worker.process(f.ref)); assert.deepEqual(f.deleted, []);
});

test('publication winning the cleanup CAS cannot lose its object', async () => {
  const f = fixture(); f.advance();
  f.client.beforeCommit = () => {
    f.client.beforeCommit = null;
    alter(f.client, `PLAYER#${f.playerId}`, 'PRESENTATION', { portrait: f.portrait });
    alter(f.client, profileWorkPartition(f.playerId), f.ref.key, { status: 'active' });
  };
  assert.deepEqual(await f.worker.process(f.ref), { done: false }); assert.deepEqual(f.deleted, []);
  assert.deepEqual(await f.worker.process(f.ref), { done: true }); assert.equal(state(f).status, 'active');
});

test('failed deletion and lost acknowledgements remain retryable without touching a replacement', async () => {
  const f = fixture('cleanup');
  f.client.loseAck = () => { f.client.loseAck = null; return true; };
  await assert.rejects(f.worker.process(f.ref), /lost acknowledgement/); assert.equal(state(f).status, 'deleting');
  const replacement = { ...f.portrait, jobId: randomUUID(), objectKey: `portraits/${historyHash(f.playerId)}/${randomUUID()}.png` };
  // Only the pointer's matching job ID matters to this old upload's cleanup;
  // construct a valid different immutable key to keep the presentation coherent.
  replacement.objectKey = `portraits/${historyHash(f.playerId)}/${replacement.jobId}.png`;
  alter(f.client, `PLAYER#${f.playerId}`, 'PRESENTATION', { portrait: replacement });
  let fail = true;
  f.store.delete = async key => { if (fail) { fail = false; throw new Error('storage unavailable'); } f.deleted.push(key); };
  await assert.rejects(f.worker.process(f.ref), /storage unavailable/); assert.equal(state(f).status, 'deleting');
  f.client.loseAck = actions => {
    if (!actions.some(action => action.Put?.Item?.data.S?.includes('"deleted"'))) return false;
    f.client.loseAck = null; return true;
  };
  await assert.rejects(f.worker.process(f.ref), /lost acknowledgement/); assert.equal(state(f).status, 'deleted');
  assert.deepEqual(await f.worker.process(f.ref), { done: true }); assert.deepEqual(f.deleted, [f.portrait.objectKey]);
  assert.deepEqual(body(f.client.read(`PLAYER#${f.playerId}`, 'PRESENTATION')!).portrait, replacement);
});

test('identity, pointer and readiness changes fail cleanup fences', async () => {
  for (const scenario of ['identity', 'presentation', 'readiness']) {
    const f = fixture('cleanup');
    f.client.beforeCommit = () => {
      f.client.beforeCommit = null;
      if (scenario === 'identity') alter(f.client, `PLAYER#${f.playerId}`, 'IDENTITY', { writeVersion: randomUUID() });
      if (scenario === 'presentation') alter(f.client, `PLAYER#${f.playerId}`, 'PRESENTATION', { nameRevision: randomUUID() });
      if (scenario === 'readiness') alter(f.client, 'PLAYER_HISTORY', 'CONTROL', { enabled: false });
    };
    assert.equal((await f.worker.process(f.ref)).done, false); assert.equal(state(f).status, 'cleanup'); assert.deepEqual(f.deleted, []);
  }
});

test('consolidation retires an alias portrait with a bounded checkpoint and keeps retained visibility', async () => {
  const f = fixture('active', true, 'alias');
  alter(f.client, 'PLAYER#alias', 'IDENTITY', { rootId: 'retained', members: [] });
  const item = portraitRetirementItem('table', 'retained', ['alias', 'empty'], randomUUID(), at).Put!.Item!;
  f.client.items.set(key(item), item);
  f.client.seed('PLAYER#empty', 'IDENTITY', 'playerIdentity', { playerId: 'empty', rootId: 'retained', members: [],
    identityVersion: 2, writeVersion: 'x', displayName: 'Empty', formerNames: [] });
  const reference = { version: 1 as const, kind: 'profile' as const, playerHash: historyHash('retained'), key: item.sk.S! };
  assert.equal((await f.worker.process(reference)).done, false); assert.equal(state(f).status, 'cleanup');
  assert.equal(body(f.client.read(item.pk.S!, item.sk.S!)!).memberIndex, 1);
  assert.equal((await f.worker.process(reference)).done, true); assert.deepEqual(f.deleted, []);
  await f.worker.process(f.ref); await f.worker.process(f.ref); assert.deepEqual(f.deleted, [f.portrait.objectKey]);
  // Historical alias presentation stays private; the worker has no PLAYER writes.
  assert.deepEqual(body(f.client.read('PLAYER#alias', 'PRESENTATION')!).portrait, f.portrait);
});

test('retirement cannot delete a still-canonical player or advance corrupt scope', async () => {
  const f = fixture('active', true);
  const item = portraitRetirementItem('table', 'retained', [f.playerId], randomUUID(), at).Put!.Item!; f.client.items.set(key(item), item);
  const ref = { version: 1 as const, kind: 'profile' as const, playerHash: historyHash('retained'), key: item.sk.S! };
  await assert.rejects(f.worker.process(ref)); assert.deepEqual(f.deleted, []); assert.equal(state(f).status, 'active');
  await assert.rejects(f.worker.process({ ...f.ref, playerHash: 'b'.repeat(64) }));
});

test('duplicate deliveries and filtered operator pages retain safe continuations', async () => {
  const f = fixture('cleanup', false, 'p/λ#%');
  await Promise.all([f.worker.process(f.ref), f.worker.process(f.ref)]);
  assert.equal(state(f).status, 'deleting'); await Promise.all([f.worker.process(f.ref), f.worker.process(f.ref)]);
  assert.equal(state(f).status, 'deleted'); assert(f.deleted.every(key => key === f.portrait.objectKey));
  for (let index = 0; index < 22; index++) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    f.client.seed(profileWorkPartition(f.playerId), profileMediaWorkKey(id), 'playerProfileMediaWork', {
      ...state(f), jobId: id, objectKey: `portraits/${historyHash(f.playerId)}/${id}.png`, status: 'deleted',
    });
  }
  alter(f.client, 'PLAYER_HISTORY', 'CONTROL', { enabled: false });
  const page = await f.worker.pendingPage(f.playerId); assert.deepEqual(page.refs, []); assert(page.cursor);
  const next = await f.worker.pendingPage(f.playerId, 'media', page.cursor); assert.deepEqual(next.refs, []); assert.equal(next.cursor, null);
  f.client.advanceCursor = true; await assert.rejects(f.worker.pendingPage(f.playerId));
});


test('recently removed or retired portraits retain the upload lease before physical deletion', async () => {
  for (const status of ['cleanup', 'active']) {
    const f = fixture(status);
    alter(f.client, profileWorkPartition(f.playerId), f.ref.key, { notBefore: new Date(Date.parse(at) + 120_000).toISOString() });
    assert.equal(body(f.client.read(`PLAYER#${f.playerId}`, 'PRESENTATION')!).portrait, null);
    assert.deepEqual(await f.worker.process(f.ref), { done: false, delaySeconds: 120 }); assert.deepEqual(f.deleted, []);
    f.advance(); assert.equal((await f.worker.process(f.ref)).done, false); assert.equal(state(f).status, 'deleting');
    assert.equal((await f.worker.process(f.ref)).done, true); assert.deepEqual(f.deleted, [f.portrait.objectKey]);
  }
});
