import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { BatchGetItemCommand, GetItemCommand, QueryCommand, TransactWriteItemsCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { ProfileNameWorker } from '../data/player-profile-name-worker.js';
import { profileWorkPartition, profileNameWorkKey, profileWorkReference } from '../data/player-profile-work.js';
import { historyKey, historyRow, type HistoryItem } from '../data/player-history-model.js';
import { identityDirectorySk, identityLeagueSk, identityTombstoneSk } from '../data/player-identity.js';
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

function fixture(playerId = 'player') {
  const client = new MemoryClient(), nameRevision = randomUUID();
  client.seed('PLAYER_IDENTITY', 'CONTROL', 'playerIdentityControl', { mode: 'fenced', coverage: 'verified', epoch: 'e1', writerVersion: 1 });
  client.seed('PLAYER_HISTORY', 'CONTROL', 'playerHistoryReadiness', { version: 1, enabled: true, revision: randomUUID(), ruleVersion: 1,
    activatedAt: at, manifest: { version: 1, writerVersion: 1, writerSha: 'a'.repeat(40), tableName: 'table', accountId: '123456789012',
      region: 'ap-southeast-2', reviewedPlan: 'https://github.com/ajfisher/3fc/pull/209', drainedAt: at, ruleVersion: 1 } });
  client.seed(`PLAYER#${playerId}`, 'IDENTITY', 'playerIdentity', { playerId, rootId: playerId, members: [playerId],
    identityVersion: 1, writeVersion: 'w1', displayName: 'New Name', formerNames: ['Old Name'] });
  client.seed(`PLAYER#${playerId}`, 'PRESENTATION', 'playerPresentation', { version: 1, playerId, nameRevision });
  const ref = profileWorkReference(playerId, nameRevision);
  client.seed(profileWorkPartition(playerId), profileNameWorkKey(nameRevision), 'playerProfileNameWork', {
    version: 1, jobId: nameRevision, playerId, nameRevision, displayName: 'New Name', status: 'pending', members: [playerId],
    memberIndex: 0, cursor: null, createdAt: at, updatedAt: at,
  });
  return { client, ref, worker: new ProfileNameWorker(client, 'table', () => at), playerId };
}
function league(client: MemoryClient, id: string, playerId = 'player', memberId = playerId, active = true) {
  client.seed(`LEAGUE#${id}`, 'METADATA', 'league', { leagueId: id, name: id });
  client.seed(`LEAGUE#${id}`, 'PLAYER_DIRECTORY', 'playerDirectoryRevision', { revision: 'd1' });
  client.seed(`LEAGUE#${id}`, identityDirectorySk(playerId), 'leaguePlayer', {
    playerId, nickname: 'Old Name', formerNames: [], active, seasonIds: ['season'], hasMoreSeasons: false,
  });
  client.seed(`PLAYER#${memberId}`, identityLeagueSk(id), 'playerLeagueMembership', { playerId: memberId, leagueId: id });
  client.seed(`PLAYER#${playerId}`, identityLeagueSk(id), 'playerLeagueMembership', { playerId, leagueId: id });
}
function alter(client: MemoryClient, pk: string, sk: string, fields: Record<string, unknown>) {
  const row = client.read(pk, sk)!; row.data = { S: JSON.stringify({ ...body(row), ...fields }) };
}
async function drain(worker: ProfileNameWorker, ref: ReturnType<typeof profileWorkReference>) {
  for (let step = 0; step < 100; step++) if ((await worker.process(ref)).done) return;
  assert.fail('fixture did not complete bounded work');
}

test('name propagation checkpoints ten leagues per step and preserves every historical ID', async () => {
  const { client, ref, worker } = fixture();
  for (let index = 0; index < 23; index++) league(client, `league-${index}`);
  client.seed('GAME#historical', 'PLAYER#player', 'gamePlayer', { playerId: 'player', nickname: 'Historical Name' });
  assert.equal((await worker.process(ref)).done, false);
  assert.equal(client.queries.length, 1); assert.equal(client.queries[0].Limit, 10);
  assert.equal([...client.items.values()].filter(row => row.entityType.S === 'leaguePlayer' && body(row).nickname === 'New Name').length, 10);
  await drain(worker, ref);
  for (let index = 0; index < 23; index++) {
    const entry = body(client.read(`LEAGUE#league-${index}`, identityDirectorySk('player'))!);
    assert.equal(entry.nickname, 'New Name'); assert.deepEqual(entry.formerNames, ['Old Name']); assert.deepEqual(entry.seasonIds, ['season']);
  }
  assert.equal(body(client.read('GAME#historical', 'PLAYER#player')!).nickname, 'Historical Name');
  assert(client.transactions.every(actions => actions.every(action => !action.Put?.Item?.pk.S?.startsWith('PLAYER#'))));
  const count = client.transactions.length; assert.equal((await worker.process(ref)).done, true); assert.equal(client.transactions.length, count);
});

test('aliases traverse safely; inactive and proven-deleted directories never reappear', async () => {
  const { client, ref, worker } = fixture();
  alter(client, 'PLAYER#player', 'IDENTITY', { members: ['player', 'alias'] });
  client.seed('PLAYER#alias', 'IDENTITY', 'playerIdentity', { playerId: 'alias', rootId: 'player', members: [], identityVersion: 1,
    writeVersion: 'a1', displayName: 'Alias', formerNames: [] });
  league(client, 'shared', 'player', 'alias'); league(client, 'inactive', 'player', 'player', false); league(client, 'deleted');
  client.seed('PLAYER_IDENTITY_TOMBSTONE', identityTombstoneSk('league', ['deleted']), 'playerIdentityTombstone', { kind: 'league', ids: ['deleted'], deletedAt: at });
  client.remove('LEAGUE#deleted', 'METADATA'); client.remove('LEAGUE#deleted', identityDirectorySk('player'));
  await drain(worker, ref);
  assert.equal(body(client.read('LEAGUE#shared', identityDirectorySk('player'))!).nickname, 'New Name');
  assert.equal(body(client.read('LEAGUE#inactive', identityDirectorySk('player'))!).nickname, 'Old Name');
  assert.equal(client.read('LEAGUE#deleted', identityDirectorySk('player')), undefined);
  assert(client.queries.some(query => query.ExpressionAttributeValues?.[':pk'].S === 'PLAYER#alias'));
});

test('newer owner name and completed consolidation supersede old work', async () => {
  for (const scenario of ['revision', 'name', 'retired']) {
    const { client, ref, worker } = fixture(); league(client, 'league');
    if (scenario === 'revision') alter(client, 'PLAYER#player', 'PRESENTATION', { nameRevision: randomUUID() });
    if (scenario === 'name') alter(client, 'PLAYER#player', 'IDENTITY', { displayName: 'Consolidated Name' });
    if (scenario === 'retired') {
      alter(client, 'PLAYER#player', 'IDENTITY', { rootId: 'retained', members: [] });
      client.seed('PLAYER#retained', 'IDENTITY', 'playerIdentity', { playerId: 'retained', rootId: 'retained', members: ['retained', 'player'],
        identityVersion: 2, writeVersion: 'r2', displayName: 'Retained', formerNames: [] });
    }
    assert.equal((await worker.process(ref)).done, true);
    assert.equal(body(client.read('LEAGUE#league', identityDirectorySk('player'))!).nickname, 'Old Name');
    assert.equal(body(client.read(profileWorkPartition('player'), ref.key)!).completionReason, 'superseded');
  }
});

test('root, directory, readiness and presentation races cannot advance a checkpoint', async () => {
  for (const scenario of ['root', 'directory', 'readiness', 'presentation']) {
    const { client, ref, worker } = fixture(); league(client, 'league');
    client.beforeCommit = () => {
      client.beforeCommit = null;
      if (scenario === 'root') alter(client, 'PLAYER#player', 'IDENTITY', { writeVersion: 'w2' });
      if (scenario === 'directory') alter(client, 'LEAGUE#league', 'PLAYER_DIRECTORY', { revision: 'd2' });
      if (scenario === 'readiness') alter(client, 'PLAYER_HISTORY', 'CONTROL', { enabled: false });
      if (scenario === 'presentation') alter(client, 'PLAYER#player', 'PRESENTATION', { nameRevision: randomUUID() });
    };
    assert.equal((await worker.process(ref)).done, false);
    assert.equal(body(client.read('LEAGUE#league', identityDirectorySk('player'))!).nickname, 'Old Name');
    assert.equal(body(client.read(profileWorkPartition('player'), ref.key)!).memberIndex, 0);
    if (scenario === 'root' || scenario === 'directory') {
      await drain(worker, ref); assert.equal(body(client.read('LEAGUE#league', identityDirectorySk('player'))!).nickname, 'New Name');
    }
  }
});

test('lost acknowledgement replays its durable checkpoint without another directory revision', async () => {
  const { client, ref, worker } = fixture(); league(client, 'league');
  client.loseAck = () => { client.loseAck = null; return true; };
  await assert.rejects(worker.process(ref), /lost acknowledgement/);
  const revision = body(client.read('LEAGUE#league', 'PLAYER_DIRECTORY')!).revision;
  assert.equal((await worker.process(ref)).done, true);
  assert.equal(body(client.read('LEAGUE#league', 'PLAYER_DIRECTORY')!).revision, revision);
});

test('missing or corrupt live associations cannot masquerade as completed propagation', async () => {
  for (const scenario of ['missing-directory', 'missing-league', 'foreign-membership', 'wrong-hash']) {
    const { client, ref, worker } = fixture(); league(client, 'league');
    if (scenario === 'missing-directory') client.remove('LEAGUE#league', identityDirectorySk('player'));
    if (scenario === 'missing-league') client.remove('LEAGUE#league', 'METADATA');
    if (scenario === 'foreign-membership') alter(client, 'PLAYER#player', identityLeagueSk('league'), { leagueId: 'other' });
    if (scenario === 'wrong-hash') alter(client, profileWorkPartition('player'), ref.key, { playerId: 'other' });
    await assert.rejects(worker.process(ref));
    assert.equal(body(client.read(profileWorkPartition('player'), ref.key)!).status, 'pending');
  }
});

test('opaque IDs are preserved and a paused processor can still inspect filtered continuation pages', async () => {
  const { client, ref, worker, playerId } = fixture('p/λ#%'); league(client, 'league/λ#%', playerId);
  await drain(worker, ref);
  alter(client, 'PLAYER_HISTORY', 'CONTROL', { enabled: false });
  for (let index = 0; index < 22; index++) {
    const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
    const original = body(client.read(profileWorkPartition(playerId), ref.key)!);
    client.seed(profileWorkPartition(playerId), profileNameWorkKey(id), 'playerProfileNameWork', { ...original, jobId: id, nameRevision: id });
  }
  const page = await worker.pendingPage(playerId); assert.deepEqual(page.refs, []); assert(page.cursor);
  const next = await worker.pendingPage(playerId, page.cursor); assert.deepEqual(next.refs, []); assert.equal(next.cursor, null);
  const pending = randomUUID(); const original = body(client.read(profileWorkPartition(playerId), ref.key)!);
  client.seed(profileWorkPartition(playerId), profileNameWorkKey(pending), 'playerProfileNameWork', { ...original, jobId: pending, nameRevision: pending, status: 'pending' });
  await assert.rejects(worker.process(profileWorkReference(playerId, pending)), /not been activated/);
});

test('malformed stored and advanced response cursors cannot skip directory updates', async () => {
  for (const scenario of ['stored', 'response']) {
    const { client, ref, worker } = fixture(); league(client, 'league');
    if (scenario === 'stored') alter(client, profileWorkPartition('player'), ref.key, { cursor: 'ZZZ' });
    else client.advanceCursor = true;
    await assert.rejects(worker.process(ref));
    assert.equal(body(client.read(profileWorkPartition('player'), ref.key)!).status, 'pending');
    assert.equal(body(client.read('LEAGUE#league', identityDirectorySk('player'))!).nickname, 'Old Name');
  }
});

test('duplicate concurrent delivery commits one directory change and preserves its checkpoint', async () => {
  const { client, ref, worker } = fixture(); league(client, 'league');
  const results = await Promise.all([worker.process(ref), worker.process(ref)]);
  assert.equal(results.filter(result => result.done).length, 1);
  assert.equal((await worker.process(ref)).done, true);
  assert.equal(body(client.read('LEAGUE#league', identityDirectorySk('player'))!).nickname, 'New Name');
});
