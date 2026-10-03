import assert from 'node:assert/strict';
import test from 'node:test';
import { GetItemCommand, QueryCommand, TransactWriteItemsCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { ACHIEVEMENT_RULE_VERSION } from '@3fc/contracts';
import { HistoryCoordinator, historyJobKey, publicationCurrent } from '../data/player-history-coordinator.js';
import { activateHistory, disableHistoryReadiness, readHistoryReadiness, type HistoryActivationManifest } from '../data/player-history-readiness.js';
import { historyKey, historyRow, type HistoryItem } from '../data/player-history-model.js';
import { PlayerHistoryStore } from '../data/player-history-store.js';
import { historyMutationItems } from '../data/player-history-work.js';
import { identityDirectorySk, identityGameSk, identityTombstoneSk } from '../data/player-identity.js';
import type { HistoryQueueReference } from '../history-transport.js';
import { goalSk } from '../data/keys.js';
import { publicUnlock } from '../achievements/evaluate.js';

const at = '2026-10-03T00:00:00.000Z';
const key = (item: HistoryItem): string => JSON.stringify([item.pk!.S, item.sk!.S]);
const body = (item: HistoryItem): Record<string, any> => JSON.parse(item.data!.S!);
const manifest: HistoryActivationManifest = { version: 1, writerVersion: 1, writerSha: 'a'.repeat(40),
  tableName: 'table', accountId: '123456789012', region: 'ap-southeast-2',
  reviewedPlan: 'https://github.com/ajfisher/3fc/pull/207', drainedAt: at, ruleVersion: ACHIEVEMENT_RULE_VERSION };
class MemoryClient {
  items = new Map<string, HistoryItem>();
  transactions: TransactWriteItem[][] = [];
  queries: QueryCommand['input'][] = [];
  beforeCommit: ((actions: TransactWriteItem[]) => void | Promise<void>) | null = null;
  loseAck: ((actions: TransactWriteItem[]) => boolean) | null = null;
  seed(pk: string, sk: string, type: string, data: unknown) {
    const item = historyRow(pk, sk, type, data); this.items.set(key(item), item); return item;
  }
  read(pk: string, sk: string) { return this.items.get(key(historyKey(pk, sk))); }
  remove(pk: string, sk: string) { this.items.delete(key(historyKey(pk, sk))); }
  async send(command: unknown): Promise<unknown> {
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
const writes = (actions: TransactWriteItem[], type: string) => actions.some(action => action.Put?.Item?.entityType?.S === type);
const directoryRef: HistoryQueueReference = { version: 1, kind: 'directory', leagueId: 'league', key: 'PLAYER_DIRECTORY' };
function addPlayer(client: MemoryClient, playerId: string, active = true) {
  client.seed(`PLAYER#${playerId}`, 'IDENTITY', 'playerIdentity', { playerId, rootId: playerId, members: [playerId],
    writeVersion: `identity-${playerId}`, identityVersion: 1, displayName: playerId, formerNames: [] });
  client.seed('LEAGUE#league', identityDirectorySk(playerId), 'leaguePlayer', { playerId, active, nickname: playerId });
}
async function fixture(players = ['player']) {
  const client = new MemoryClient();
  client.seed('PLAYER_IDENTITY', 'CONTROL', 'playerIdentityControl', { mode: 'fenced', coverage: 'verified', epoch: 'e1', writerVersion: 1 });
  client.seed('LEAGUE#league', 'METADATA', 'league', { leagueId: 'league' });
  client.seed('LEAGUE#league', 'PLAYER_DIRECTORY', 'playerDirectoryRevision', { revision: 'directory-1' });
  for (const id of players) addPlayer(client, id);
  await activateHistory(client, 'table', manifest, at);
  const coordinator = new HistoryCoordinator(client, 'table', () => at), store = new PlayerHistoryStore(client, 'table');
  const ref = await coordinator.requestRebuild('league');
  return { client, coordinator, store, ref };
}
async function drain(coordinator: HistoryCoordinator, reference: HistoryQueueReference, limit = 500) {
  for (let steps = 0; steps < limit; steps++) if ((await coordinator.process(reference)).done) return steps + 1;
  assert.fail('bounded fixture did not finish');
}
function sourceRevision(client: MemoryClient) { return body(client.read('LEAGUE#league', 'HISTORY_SOURCE')!).revision as string; }
function loseOnce(client: MemoryClient, type: string) {
  client.loseAck = actions => {
    if (!writes(actions, type)) return false;
    client.loseAck = null; return true;
  };
}

test('directory activation after completed backfill publishes a new zero-appearance player without another game', async () => {
  const { client, coordinator, store, ref } = await fixture();
  await drain(coordinator, directoryRef); await drain(coordinator, ref);
  assert.equal((await coordinator.status('league'))?.phase, 'complete');
  const before = sourceRevision(client);
  addPlayer(client, 'new-player');
  client.seed('LEAGUE#league', 'PLAYER_DIRECTORY', 'playerDirectoryRevision', { revision: 'directory-2' });
  assert.equal(await store.getPublication('league', 'new-player'), null);
  await drain(coordinator, directoryRef);
  assert.notEqual(sourceRevision(client), before);
  const publication = await store.getPublication('league', 'new-player');
  assert(publicationCurrent(publication, sourceRevision(client), body(client.read('PLAYER_HISTORY', 'CONTROL')!).revision));
  assert.equal((await store.getSummary('league', 'new-player', { scope: 'career', seasonId: null }))?.state.totals.played, 0);
  assert.equal((await coordinator.status('league'))?.checked, 2);
  assert.deepEqual((await coordinator.pendingPage('league', 'work')).refs, []);
});

test('first directory activation initializes an empty league history source and reaches a complete zero total', async () => {
  const { client, coordinator, store, ref } = await fixture();
  client.remove('LEAGUE#league', 'HISTORY_SOURCE'); client.remove('LEAGUE#league', ref.key);
  assert.deepEqual(await coordinator.pendingPage('league', 'work'), { refs: [directoryRef], cursor: null });
  await drain(coordinator, directoryRef);
  const receipt = body(client.read('LEAGUE#league', 'HISTORY_DIRECTORY')!);
  const work = body(client.read('LEAGUE#league', receipt.workKey)!);
  assert.equal(work.revision, sourceRevision(client));
  assert.equal((await store.getSummary('league', 'player', { scope: 'career', seasonId: null }))?.state.totals.played, 0);
  assert.equal((await coordinator.status('league'))?.phase, 'complete');
});

test('duplicate directory delivery and a lost bridge acknowledgement allocate only one durable work marker', async () => {
  const { client, coordinator, store } = await fixture();
  const markers = () => [...client.items.values()].filter(item => item.entityType.S === 'playerHistoryWork').length;
  const before = markers();
  loseOnce(client, 'playerHistoryDirectoryReceipt');
  await assert.rejects(coordinator.process(directoryRef), /lost acknowledgement/);
  const committed = body(client.read('LEAGUE#league', 'HISTORY_DIRECTORY')!), revision = sourceRevision(client);
  assert.equal(markers(), before + 1);
  await Promise.all([coordinator.process(directoryRef), coordinator.process(directoryRef)]);
  await drain(coordinator, directoryRef);
  assert.equal(sourceRevision(client), revision); assert.equal(markers(), before + 1);
  assert.deepEqual(body(client.read('LEAGUE#league', 'HISTORY_DIRECTORY')!), committed);
  assert(await store.getPublication('league', 'player'));
  const audits = [...client.items.values()].filter(item => item.entityType.S === 'playerHistoryPublicationAudit').length;
  assert.deepEqual(await coordinator.process(directoryRef), { done: true });
  assert.equal([...client.items.values()].filter(item => item.entityType.S === 'playerHistoryPublicationAudit').length, audits);
});

test('a directory revision raced at bridge commit cannot leave a stale receipt or partial work marker', async () => {
  const { client, coordinator, store } = await fixture();
  const previousSource = sourceRevision(client);
  const previousMarkers = [...client.items.values()].filter(item => item.entityType.S === 'playerHistoryWork').length;
  client.beforeCommit = actions => {
    if (!writes(actions, 'playerHistoryDirectoryReceipt')) return;
    client.beforeCommit = null; addPlayer(client, 'raced-player');
    client.seed('LEAGUE#league', 'PLAYER_DIRECTORY', 'playerDirectoryRevision', { revision: 'directory-raced' });
  };
  assert.deepEqual(await coordinator.process(directoryRef), { done: false });
  assert.equal(client.read('LEAGUE#league', 'HISTORY_DIRECTORY'), undefined);
  assert.equal(sourceRevision(client), previousSource);
  assert.equal([...client.items.values()].filter(item => item.entityType.S === 'playerHistoryWork').length, previousMarkers);
  await drain(coordinator, directoryRef);
  assert.equal(body(client.read('LEAGUE#league', 'HISTORY_DIRECTORY')!).directoryData,
    client.read('LEAGUE#league', 'PLAYER_DIRECTORY')!.data.S);
  assert(await store.getPublication('league', 'raced-player'));
});

test('keyed recovery discovers an unprocessed directory revision after its stream event has expired', async () => {
  const { client, coordinator, store, ref } = await fixture();
  await drain(coordinator, directoryRef); await drain(coordinator, ref);
  addPlayer(client, 'missed-stream-player');
  client.seed('LEAGUE#league', 'PLAYER_DIRECTORY', 'playerDirectoryRevision', { revision: 'directory-missed-stream' });
  const revision = sourceRevision(client), queriesBefore = client.queries.length;
  // No stream/SQS delivery and no new game or explicit operator rebuild exist.
  const page = await coordinator.pendingPage('league', 'work');
  assert.deepEqual(page, { refs: [directoryRef], cursor: null });
  assert.equal(sourceRevision(client), revision, 'discovery remains read-only');
  assert(client.queries.slice(queriesBefore).every(query => query.Limit! <= 20 && query.ExpressionAttributeValues![':pk'].S === 'LEAGUE#league'));
  await drain(coordinator, page.refs[0]);
  assert(await store.getPublication('league', 'missed-stream-player'));
  assert.deepEqual((await coordinator.pendingPage('league', 'work')).refs, []);
});

test('directory bridge obeys readiness and league tombstones without creating unauthorized work', async () => {
  const { client, coordinator } = await fixture();
  const previous = sourceRevision(client);
  const disabled = disableHistoryReadiness('table', 'migration', at).Put!.Item!;
  client.items.set(key(disabled), disabled);
  await assert.rejects(coordinator.process(directoryRef), /not been activated/);
  assert.equal(sourceRevision(client), previous); assert.equal(client.read('LEAGUE#league', 'HISTORY_DIRECTORY'), undefined);
  client.seed('PLAYER_IDENTITY_TOMBSTONE', identityTombstoneSk('league', ['league']), 'playerIdentityTombstone',
    { kind: 'league', ids: ['league'] });
  assert.deepEqual(await coordinator.process(directoryRef), { done: true });
  assert.equal(sourceRevision(client), previous); assert.equal(client.read('LEAGUE#league', 'HISTORY_DIRECTORY'), undefined);
});

test('concurrent initial directory bridges commit only one receipt and work marker', async () => {
  const { client, coordinator } = await fixture();
  const before = [...client.items.values()].filter(item => item.entityType.S === 'playerHistoryWork').length;
  const results = await Promise.all([coordinator.process(directoryRef), coordinator.process(directoryRef)]);
  assert(results.every(result => !result.done));
  assert.equal([...client.items.values()].filter(item => item.entityType.S === 'playerHistoryWork').length, before + 1);
  const receipt = body(client.read('LEAGUE#league', 'HISTORY_DIRECTORY')!);
  assert.equal(body(client.read('LEAGUE#league', receipt.workKey)!).revision, sourceRevision(client));
  await drain(coordinator, directoryRef);
});

test('malformed directory receipts cannot suppress keyed recovery of their durable obligation', async () => {
  for (const damage of ['workKey', 'leagueId', 'version']) {
    const { client, coordinator } = await fixture(); await drain(coordinator, directoryRef);
    const receipt = client.read('LEAGUE#league', 'HISTORY_DIRECTORY')!, data = body(receipt);
    if (damage === 'workKey') delete data.workKey;
    else if (damage === 'leagueId') data.leagueId = 'another-league';
    else data.version = 99;
    receipt.data = { S: JSON.stringify(data) };
    await assert.rejects(coordinator.pendingPage('league', 'work'));
    await assert.rejects(coordinator.process(directoryRef));
  }
});

test('activation requires verified identity coverage; a source token alone cannot assert history readiness', async () => {
  const client = new MemoryClient();
  client.seed('PLAYER_IDENTITY', 'CONTROL', 'playerIdentityControl', { mode: 'fenced', coverage: 'unknown', epoch: 'e1', writerVersion: 1 });
  await assert.rejects(activateHistory(client, 'table', manifest, at), /being prepared/);
  client.seed('LEAGUE#league', 'HISTORY_SOURCE', 'playerHistorySource', { leagueId: 'league', version: 1, revision: 'r1' });
  await assert.rejects(readHistoryReadiness(client, 'table'), /not been activated/);
  const coordinator = new HistoryCoordinator(client, 'table', () => at);
  await assert.rejects(coordinator.requestRebuild('league'), /not been activated/);
  assert.equal(client.read('PLAYER_HISTORY', 'CONTROL'), undefined);
});

test('activation retries preserve the readiness revision after lost acknowledgement and invalidation closes reads', async () => {
  const { client } = await fixture();
  const nextManifest = { ...manifest, writerSha: 'b'.repeat(40) };
  loseOnce(client, 'playerHistoryReadiness');
  await assert.rejects(activateHistory(client, 'table', nextManifest, at), /lost acknowledgement/);
  const committed = body(client.read('PLAYER_HISTORY', 'CONTROL')!);
  const retried = await activateHistory(client, 'table', nextManifest, at);
  assert.equal(retried.revision, committed.revision);
  const disabled = disableHistoryReadiness('table', 'migration', at).Put!.Item!;
  client.items.set(key(disabled), disabled);
  await assert.rejects(readHistoryReadiness(client, 'table'), /not been activated/);
  await assert.rejects(activateHistory(client, 'table', { ...manifest, tableName: 'elsewhere' }, at), /not applicable/);
  await assert.rejects(activateHistory(client, 'table', { ...manifest, drainedAt: '2026-10-04T00:00:00Z' }, at), /not applicable/);
});

test('league sweep includes every active zero-appearance player and cannot complete after fanout alone', async () => {
  const players = Array.from({ length: 12 }, (_, index) => `player-${index}`);
  const { client, coordinator, store, ref } = await fixture(players);
  addPlayer(client, 'inactive', false);
  assert.deepEqual(await coordinator.process(ref), { done: false });
  assert.equal((await coordinator.status('league'))?.phase, 'fanout');
  await coordinator.process(ref); await coordinator.process(ref);
  assert.equal((await coordinator.status('league'))?.phase, 'verify');
  assert.equal(await store.getPublication('league', players[0]), null);
  assert.equal(client.read('LEAGUE#league', `HISTORY_ACK#${ref.key.slice('HISTORY_WORK#'.length)}`), undefined);
  await drain(coordinator, ref);
  const status = await coordinator.status('league');
  assert.equal(status?.phase, 'complete'); assert.equal(status?.enqueued, 12); assert.equal(status?.checked, 12);
  for (const id of players) {
    const publication = await store.getPublication('league', id);
    assert(publicationCurrent(publication, sourceRevision(client), body(client.read('PLAYER_HISTORY', 'CONTROL')!).revision));
    assert.equal((await store.getSummary('league', id, { scope: 'career', seasonId: null }))?.state.totals.played, 0);
    assert.equal(body(client.read('LEAGUE#league', historyJobKey(id))!).status, 'done');
  }
  assert.equal(client.read('LEAGUE#league', historyJobKey('inactive')), undefined);
  assert(client.queries.filter(query => query.ExpressionAttributeValues![':prefix'].S === 'PLAYER#').length >= 4);
  assert(client.queries.every(query => query.Limit! <= 20));
});

test('old work markers coalesce to the latest source revision without duplicate publications', async () => {
  const { client, coordinator, store, ref } = await fixture();
  const newer = await coordinator.requestRebuild('league'), current = sourceRevision(client);
  await drain(coordinator, ref); await drain(coordinator, newer);
  assert.equal((await store.getPublication('league', 'player'))?.sourceRevision, current);
  assert.equal([...client.items.values()].filter(item => item.entityType.S === 'playerHistoryPublicationAudit').length, 1);
  assert.equal([...client.items.values()].filter(item => item.entityType.S === 'playerHistoryAcknowledgement').length, 2);
  assert.deepEqual((await coordinator.pendingPage('league', 'work')).refs, [directoryRef],
    'ordinary completed markers do not acknowledge the still-unbridged directory revision');
});

test('duplicate worker delivery and lost generation/publication acknowledgements resume durable checkpoints', async () => {
  const { client, coordinator, store } = await fixture();
  const ref = await coordinator.ensurePlayer('league', 'player');
  const results = await Promise.all([coordinator.process(ref), coordinator.process(ref)]);
  assert(results.every(result => !result.done));
  loseOnce(client, 'playerHistoryGeneration');
  await assert.rejects(coordinator.process(ref), /lost acknowledgement/);
  // A publication can commit even though its worker did not receive the response.
  loseOnce(client, 'playerHistoryPublication');
  let sawLostAck = false;
  for (let count = 0; count < 20; count++) {
    try { if ((await coordinator.process(ref)).done) break; }
    catch (error) { assert.match(String(error), /lost acknowledgement/); sawLostAck = true; }
  }
  assert(sawLostAck); assert((await coordinator.process(ref)).done);
  assert(await store.getPublication('league', 'player'));
  assert.equal([...client.items.values()].filter(item => item.entityType.S === 'playerHistoryPublicationAudit').length, 1);
});

test('lost job and sweep acknowledgement replies cannot allocate duplicate jobs or lose obligations', async () => {
  const { client, coordinator, ref } = await fixture();
  loseOnce(client, 'playerHistoryJob');
  await assert.rejects(coordinator.ensurePlayer('league', 'player'), /lost acknowledgement/);
  const generation = body(client.read('LEAGUE#league', historyJobKey('player'))!).spec.generation;
  await coordinator.ensurePlayer('league', 'player');
  assert.equal(body(client.read('LEAGUE#league', historyJobKey('player'))!).spec.generation, generation);
  loseOnce(client, 'playerHistoryAcknowledgement');
  await assert.rejects(drain(coordinator, ref), /lost acknowledgement/);
  assert.deepEqual(await coordinator.process(ref), { done: true });
  assert.equal([...client.items.values()].filter(item => item.entityType.S === 'playerHistoryAcknowledgement').length, 1);
});

test('a changed source replaces stale in-flight generations before any stale publication', async () => {
  const { client, coordinator, store } = await fixture();
  const ref = await coordinator.ensurePlayer('league', 'player'); await coordinator.process(ref);
  const prior = body(client.read('LEAGUE#league', historyJobKey('player'))!).spec.generation;
  await coordinator.requestRebuild('league'); await coordinator.process(ref);
  const next = body(client.read('LEAGUE#league', historyJobKey('player'))!).spec.generation;
  assert.notEqual(next, prior); assert.equal(await store.getPublication('league', 'player'), null);
  await drain(coordinator, ref);
  assert.equal((await store.getPublication('league', 'player'))?.sourceRevision, sourceRevision(client));
  assert.equal([...client.items.values()].filter(item => item.entityType.S === 'playerHistoryPublicationAudit').length, 1);
});

test('directory changes fence a partially enumerated sweep and include newly added players on restart', async () => {
  const { client, coordinator, store, ref } = await fixture();
  await coordinator.process(ref);
  client.beforeCommit = actions => {
    if (!writes(actions, 'playerHistorySweep')) return;
    client.beforeCommit = null;
    addPlayer(client, 'new-player');
    client.seed('LEAGUE#league', 'PLAYER_DIRECTORY', 'playerDirectoryRevision', { revision: 'directory-2' });
  };
  assert.deepEqual(await coordinator.process(ref), { done: false });
  assert.equal((await coordinator.status('league'))?.phase, 'fanout', 'stale fanout checkpoint was not committed');
  await drain(coordinator, ref);
  assert(await store.getPublication('league', 'new-player'));
  assert.equal((await coordinator.status('league'))?.checked, 2);
});

test('broken source jobs stay failed until explicit recovery and never publish a fabricated empty total', async () => {
  const { client, coordinator, store } = await fixture();
  client.seed('PLAYER#player', identityGameSk('missing'), 'playerGameMembership', {
    playerId: 'player', gameId: 'missing', leagueId: 'league', seasonId: 'winter', gameStartTs: at });
  const ref = await coordinator.ensurePlayer('league', 'player');
  await assert.rejects(drain(coordinator, ref), /missing without deletion/);
  const failed = body(client.read('LEAGUE#league', historyJobKey('player'))!);
  assert.equal(failed.status, 'failed'); assert.equal(await store.getPublication('league', 'player'), null);
  await assert.rejects(coordinator.process(ref), /explicit recovery/);
  assert.equal((await coordinator.pendingPage('league', 'player')).refs.length, 1);
  client.remove('PLAYER#player', identityGameSk('missing'));
  await coordinator.recoverPlayer('league', 'player');
  assert.notEqual(body(client.read('LEAGUE#league', historyJobKey('player'))!).spec.generation, failed.spec.generation);
  await drain(coordinator, ref);
  assert.equal((await store.getSummary('league', 'player', { scope: 'career', seasonId: null }))?.state.totals.played, 0);
});

test('canonical consolidation forwards existing alias jobs to the retained player', async () => {
  const { client, coordinator, store } = await fixture(['alias', 'retained']);
  const aliasRef = await coordinator.ensurePlayer('league', 'alias');
  const retained = body(client.read('PLAYER#retained', 'IDENTITY')!), alias = body(client.read('PLAYER#alias', 'IDENTITY')!);
  client.seed('PLAYER#retained', 'IDENTITY', 'playerIdentity', { ...retained, members: ['retained', 'alias'], writeVersion: 'merged' });
  client.seed('PLAYER#alias', 'IDENTITY', 'playerIdentity', { ...alias, rootId: 'retained', members: [], writeVersion: 'merged' });
  client.seed('LEAGUE#league', identityDirectorySk('alias'), 'leaguePlayer', { playerId: 'alias', active: false });
  await coordinator.requestRebuild('league');
  assert.deepEqual(await coordinator.process(aliasRef), { done: true });
  const retainedRef = { version: 1, kind: 'player', leagueId: 'league', key: historyJobKey('retained') } as const;
  await drain(coordinator, retainedRef);
  assert.equal(await store.getPublication('league', 'alias'), null);
  assert(await store.getPublication('league', 'retained'));
});

test('league tombstones terminate work and player jobs, while unexplained missing league records fail', async () => {
  for (const deleted of [false, true]) {
    const { client, coordinator, ref } = await fixture();
    const playerRef = await coordinator.ensurePlayer('league', 'player');
    client.remove('LEAGUE#league', 'METADATA');
    if (deleted) {
      client.seed('PLAYER_IDENTITY_TOMBSTONE', identityTombstoneSk('league', ['league']), 'playerIdentityTombstone', { kind: 'league', ids: ['league'] });
      assert.deepEqual(await coordinator.process(ref), { done: true });
      assert.deepEqual(await coordinator.process(playerRef), { done: true });
      assert.equal(body(client.read('LEAGUE#league', historyJobKey('player'))!).status, 'done');
    } else {
      await assert.rejects(coordinator.process(ref), /League is unavailable/);
      await assert.rejects(coordinator.process(playerRef), /League is unavailable/);
    }
  }
});

test('recovery lists bounded keyed pages and keeps continuations until every marker is visited', async () => {
  const { client, coordinator } = await fixture([]);
  for (let index = 0; index < 23; index++) {
    const marker = historyMutationItems('table', { leagueId: 'league', reason: 'history-rebuild' }, at)[1].Put!.Item!;
    client.items.set(key(marker), marker);
  }
  const first = await coordinator.pendingPage('league', 'work');
  assert.equal(first.refs.length, 20); assert(first.cursor);
  const second = await coordinator.pendingPage('league', 'work', first.cursor);
  assert.equal(second.refs.length, 5); assert.equal(second.cursor, null);
  assert.deepEqual(first.refs[0], directoryRef);
  assert.equal(new Set([...first.refs, ...second.refs].map(ref => ref.key)).size, 25);
  await assert.rejects(coordinator.pendingPage('league', 'work', 'HISTORY_JOB#invalid'), /continuation/);
  assert(client.queries.every(query => query.ExpressionAttributeValues![':pk'].S === 'LEAGUE#league'));
});

test('malformed or cross-scope acknowledgements cannot silently satisfy durable work', async () => {
  for (const damage of ['entity', 'league', 'revision', 'schema']) {
    const { client, coordinator, ref } = await fixture([]);
    await drain(coordinator, ref);
    const ackKey = `HISTORY_ACK#${ref.key.slice('HISTORY_WORK#'.length)}`, row = client.read('LEAGUE#league', ackKey)!;
    if (damage === 'entity') row.entityType = { S: 'unrelated' };
    else {
      const data = body(row);
      if (damage === 'league') data.leagueId = 'other';
      else if (damage === 'revision') data.revision = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      else data.completedAt = 'invalid';
      row.data = { S: JSON.stringify(data) };
    }
    await assert.rejects(coordinator.process(ref));
    await assert.rejects(coordinator.pendingPage('league', 'work'));
  }
});

test('dry-run comparison resumes after lost acknowledgement without moving publication or appending publication audit', async () => {
  const { client, coordinator, store, ref } = await fixture();
  await drain(coordinator, ref);
  const before = await store.getPublication('league', 'player'); assert(before);
  const auditCount = [...client.items.values()].filter(item => item.entityType.S === 'playerHistoryPublicationAudit').length;
  const id = await coordinator.startComparison('league', 'player');
  loseOnce(client, 'playerHistoryGeneration');
  await assert.rejects(coordinator.stepComparison('league', id), /lost acknowledgement/);
  let complete: { done: boolean; result: unknown } = { done: false, result: null };
  for (let step = 0; step < 20 && !complete.done; step++) complete = await coordinator.stepComparison('league', id);
  assert.equal(complete.done, true);
  const result = complete.result as { priorGeneration: string; comparisonGeneration: string; totalsChanged: boolean; achievementsChanged: boolean };
  assert.equal(result.priorGeneration, before.generation); assert.equal(result.comparisonGeneration, id);
  assert.equal(result.totalsChanged, false); assert.equal(result.achievementsChanged, false);
  assert.deepEqual(await coordinator.stepComparison('league', id), complete);
  assert.deepEqual(await store.getPublication('league', 'player'), before);
  assert.equal([...client.items.values()].filter(item => item.entityType.S === 'playerHistoryPublicationAudit').length, auditCount);
  assert.equal(body(client.read('LEAGUE#league', historyJobKey('player'))!).status, 'done');
});

test('an incomplete dry-run never represents changed source data as a completed comparison', async () => {
  const { coordinator } = await fixture();
  const id = await coordinator.startComparison('league', 'player');
  assert.deepEqual(await coordinator.stepComparison('league', id), { done: false, result: null });
  await coordinator.requestRebuild('league');
  await assert.rejects(coordinator.stepComparison('league', id), /Source changed/);
});

test('rebuild collects real completed game records and corrections revoke goals and replace the final outcome', async () => {
  const { client, coordinator, store, ref } = await fixture();
  const eventKey = goalSk(1, 2, 60, 'goal');
  client.seed('PLAYER#player', identityGameSk('game'), 'playerGameMembership', {
    playerId: 'player', gameId: 'game', leagueId: 'league', seasonId: 'winter', gameStartTs: at });
  client.seed('GAME#game', 'ROSTER#red#player', 'roster', { playerId: 'player', gameId: 'game', teamId: 'red' });
  const goal = client.seed('GAME#game', eventKey, 'goal', { gameId: 'game', eventId: 'goal', scorerPlayerId: 'player',
    assistPlayerIds: [], scoringTeamId: 'red', concedingTeamId: 'blue', ownGoal: false, third: 1,
    elapsedSeconds: 60, gameMinute: 2, thirdMinute: 2, timingProvenance: { version: 1, kind: 'live' } });
  goal.createdAt = { S: '2026-10-03T00:01:00.000Z' };
  function result(scored: boolean, goals = 1) {
    const teams = ['red', 'blue', 'yellow'].map(teamId => ({ teamId,
      scored: scored && teamId === 'red' ? goals : 0, conceded: scored && teamId === 'blue' ? goals : 0,
      outcome: scored ? teamId === 'red' ? 'win' : 'loss' : 'draw' }));
    client.seed('GAME#game', 'METADATA', 'game', { gameId: 'game', leagueId: 'league', seasonId: 'winter', gameStartTs: at,
      status: 'finished', finishedAt: '2026-10-03T01:00:00.000Z', thirdLengthMinutes: 20,
      thirds: [1, 2, 3].map(third => ({ third,
        startedAt: `2026-10-03T00:${String((third - 1) * 20).padStart(2, '0')}:00.000Z`,
        finishedAt: third === 3 ? '2026-10-03T01:00:00.000Z' : `2026-10-03T00:${third * 20}:00.000Z` })),
      result: { winnerTeamId: scored ? 'red' : null, outcome: scored ? 'win' : 'draw', comparator: 'fewest_conceded_then_most_scored', teams } });
    for (const team of teams) client.seed('GAME#game', `TEAM#${team.teamId}`, 'gameTeam', { gameId: 'game', ...team });
  }
  result(true); await drain(coordinator, ref);
  const first = await store.getSummary('league', 'player', { scope: 'career', seasonId: null });
  assert.equal(first?.state.totals.played, 1); assert.equal(first?.state.totals.goals, 1); assert.equal(first?.state.totals.wins, 1);
  const firstAwards = await store.pageAwards({ leagueId: 'league', playerId: 'player', scope: { scope: 'career', seasonId: null } });
  assert(firstAwards?.items.some(award => award.achievementId === 'goal'));
  async function compare() {
    const id = await coordinator.startComparison('league', 'player');
    for (let step = 0; step < 100; step++) {
      const comparison = await coordinator.stepComparison('league', id);
      if (comparison.done) return comparison.result as { totalsChanged: boolean; achievementsChanged: boolean;
        comparisonScope: string; comparisonIncludes: string[]; before: { highest: Record<string, unknown>; counts: Record<string, number> };
        after: { highest: Record<string, unknown>; counts: Record<string, number> } };
    }
    assert.fail('bounded comparison did not finish');
  }
  // Recalculation metadata changes on an identical rebuild; player-facing badges do not.
  await coordinator.requestRebuild('league');
  const identical = await compare();
  assert.equal(identical.comparisonScope, 'career-summary');
  assert.deepEqual(identical.comparisonIncludes, ['totals', 'progress', 'assessability', 'streaks', 'highest-milestones']);
  assert.equal(identical.totalsChanged, false);
  assert.equal(identical.achievementsChanged, false, 'source revision alone is not an achievement change');
  assert.notDeepEqual(identical.before.highest, identical.after.highest, 'raw award evidence really has a different source revision');
  const extraKey = goalSk(1, 6, 300, 'second-goal');
  const extra = client.seed('GAME#game', extraKey, 'goal', { ...body(goal), eventId: 'second-goal',
    elapsedSeconds: 300, gameMinute: 6, thirdMinute: 6 });
  extra.createdAt = { S: '2026-10-03T00:05:00.000Z' }; result(true, 2);
  await coordinator.requestRebuild('league');
  const progress = await compare();
  assert.equal(progress.before.counts.goal, 1); assert.equal(progress.after.counts.goal, 2);
  assert.equal(progress.achievementsChanged, true, 'confirmed progress below the next milestone is still a semantic change');
  const publicHighest = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).map(([id, award]) =>
    [id, publicUnlock(award as Parameters<typeof publicUnlock>[0])]));
  assert.deepEqual(publicHighest(progress.after.highest), publicHighest(progress.before.highest),
    'the progress regression does not depend on a new highest badge');
  assert.equal([...client.items.values()].filter(item => item.entityType.S === 'playerHistoryPublicationAudit').length, 1,
    'both comparisons remain unpublished');
  client.remove('GAME#game', extraKey);
  client.remove('GAME#game', eventKey); result(false);
  const correction = await coordinator.requestRebuild('league'); await drain(coordinator, correction);
  const after = await store.getSummary('league', 'player', { scope: 'career', seasonId: null });
  assert.equal(after?.state.totals.played, 1); assert.equal(after?.state.totals.goals, 0);
  assert.equal(after?.state.totals.wins, 0); assert.equal(after?.state.totals.draws, 1);
  const afterAwards = await store.pageAwards({ leagueId: 'league', playerId: 'player', scope: { scope: 'career', seasonId: null } });
  assert.equal(afterAwards?.items.some(award => award.achievementId === 'goal'), false);
  assert.equal([...client.items.values()].filter(item => item.entityType.S === 'playerHistoryPublicationAudit').length, 2);
});

for (const hadPublication of [false, true]) {
  test(`comparison fences ${hadPublication ? 'an existing publication swap' : 'the first publication'} committed after its final read`, async () => {
    const { client, coordinator, store, ref } = await fixture();
    if (hadPublication) await drain(coordinator, ref);
    const previous = await store.getPublication('league', 'player');
    assert.equal(previous !== null, hadPublication);
    const revision = sourceRevision(client);
    // Prepare a real complete generation that a concurrent publisher can install.
    // Both publishers share the same source token, so a source-only fence cannot catch this race.
    const publishingId = await coordinator.startComparison('league', 'player');
    let prepared = false;
    for (let step = 0; step < 20; step++) {
      if ((await coordinator.stepComparison('league', publishingId)).done) { prepared = true; break; }
    }
    assert(prepared);
    const publishingSpec = body(client.read('LEAGUE#league', `HISTORY_COMPARE#${publishingId}`)!).spec;
    const comparisonId = await coordinator.startComparison('league', 'player');
    let raced = false;
    client.beforeCommit = async actions => {
      if (!writes(actions, 'playerHistoryComparison')) return;
      client.beforeCommit = null;
      const publication = await store.publish(publishingSpec);
      assert.equal(publication.sourceRevision, revision);
      assert.equal(publication.generation, publishingId);
      raced = true;
    };
    await assert.rejects(async () => {
      for (let step = 0; step < 20; step++) {
        const result = await coordinator.stepComparison('league', comparisonId);
        assert.equal(result.done, false, 'the stale before/priorGeneration must never be accepted');
      }
      assert.fail('comparison should have reached the publication fence');
    }, /conditional failure|Published comparison source changed/);
    assert.equal(raced, true, 'the publication changed inside the comparison commit window');
    assert.equal(sourceRevision(client), revision);
    assert.equal(body(client.read('LEAGUE#league', `HISTORY_COMPARE#${comparisonId}`)!).result, null,
      'no stale comparison result is persisted');
    const resumed = await coordinator.stepComparison('league', comparisonId);
    assert.equal(resumed.done, true);
    const result = resumed.result as { priorGeneration: string; totalsChanged: boolean; achievementsChanged: boolean };
    assert.equal(result.priorGeneration, publishingId);
    assert.equal(result.totalsChanged, false); assert.equal(result.achievementsChanged, false);
    assert.deepEqual(body(client.read('LEAGUE#league', `HISTORY_COMPARE#${comparisonId}`)!).result, resumed.result);
    assert.equal((await store.getPublication('league', 'player'))?.generation, publishingId);
    assert.equal([...client.items.values()].filter(item => item.entityType.S === 'playerHistoryPublicationAudit').length,
      hadPublication ? 2 : 1, 'comparison retry does not publish its own generation');
  });
}

test('pending status remains read-only and inspectable before activation and during rollback', async () => {
  for (const disabled of [false, true]) {
    const { client, coordinator, ref } = await fixture();
    const directory: HistoryQueueReference = { version: 1, kind: 'directory', leagueId: 'league', key: 'PLAYER_DIRECTORY' };
    if (disabled) {
      await coordinator.process(directory); // An existing receipt cannot suppress inspection after disabling.
      const item = disableHistoryReadiness('table', 'rollback', at).Put!.Item!;
      client.items.set(key(item), item);
    } else client.remove('PLAYER_HISTORY', 'CONTROL');
    const writesBefore = client.transactions.length;
    const page = await coordinator.pendingPage('league', 'work');
    assert(page.refs.some(value => value.kind === 'directory'));
    assert(page.refs.some(value => value.key === ref.key));
    assert.equal(page.cursor, null);
    assert.equal(client.transactions.length, writesBefore, 'status cannot activate or enqueue work');
    await assert.rejects(coordinator.process(directory), /not been activated/);
    assert.equal(client.transactions.length, writesBefore, 'inspection must not bypass processing readiness');
  }
});
