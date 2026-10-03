import assert from 'node:assert/strict';
import test from 'node:test';
import { GetItemCommand, TransactWriteItemsCommand } from '@aws-sdk/client-dynamodb';
import { historyMutationItems, historyMutationReasons, historyWorkSchema, sendHistoryTransaction, type HistoryMutationInput } from '../data/player-history-work.js';

const at = '2026-10-03T21:00:00+11:00';
test('source revision and durable work share one fresh token in exactly two bounded transaction actions', () => {
  const first = historyMutationItems('table', { leagueId: 'league', reason: 'goal-changed', gameId: 'opaque/game' }, at);
  const second = historyMutationItems('table', { leagueId: 'league', reason: 'goal-changed', gameId: 'opaque/game' }, at);
  assert.equal(first.length, 2);
  const [source, marker] = first.map(value => value.Put!);
  const sourceData = JSON.parse(source.Item!.data.S!), work = historyWorkSchema.parse(JSON.parse(marker.Item!.data.S!));
  assert.equal(source.TableName, 'table'); assert.equal(marker.TableName, 'table');
  assert.equal(source.Item!.pk.S, 'LEAGUE#league'); assert.equal(source.Item!.sk.S, 'HISTORY_SOURCE');
  assert.equal(source.Item!.entityType.S, 'playerHistorySource'); assert.equal(source.ConditionExpression, undefined);
  assert.deepEqual(sourceData, { leagueId: 'league', version: 1, revision: work.revision });
  assert.equal(marker.Item!.sk.S, `HISTORY_WORK#${work.revision}`); assert.equal(marker.Item!.entityType.S, 'playerHistoryWork');
  assert.equal(marker.ConditionExpression, 'attribute_not_exists(pk)');
  assert.equal(work.createdAt, '2026-10-03T10:00:00.000Z'); assert.equal(work.gameId, 'opaque/game');
  assert.notEqual(JSON.parse(second[0].Put!.Item!.data.S!).revision, sourceData.revision, 'equal timestamps cannot reuse a generation token');
  assert.equal('coverage' in sourceData, false, 'writing a dirty marker is not a coverage assertion');
});

test('all source-change reasons require enough identity to schedule bounded reconciliation', () => {
  for (const reason of historyMutationReasons) {
    const context = reason === 'identity-consolidated' ? { playerId: 'canonical' }
      : reason === 'season-deleted' ? { seasonId: 'winter' } : ['league-deleted', 'history-rebuild'].includes(reason) ? {} : { gameId: 'game' };
    const actions = historyMutationItems('table', { leagueId: 'league', reason, ...context }, at);
    assert.equal(historyWorkSchema.parse(JSON.parse(actions[1].Put!.Item!.data.S!)).reason, reason);
    if (!['league-deleted', 'history-rebuild'].includes(reason)) assert.throws(() => historyMutationItems('table', { leagueId: 'league', reason }, at));
  }
});

test('malformed or private marker fields fail before constructing source writes', () => {
  for (const input of [
    { leagueId: '', reason: 'league-deleted' },
    { leagueId: 'league', reason: 'unknown' },
    { leagueId: 'league', reason: 'game-finished', gameId: ' ' },
    { leagueId: 'league', reason: 'league-deleted', email: 'private@example.test' }
  ]) assert.throws(() => historyMutationItems('table', input as HistoryMutationInput, at));
  assert.throws(() => historyMutationItems('table', { leagueId: 'league', reason: 'league-deleted' }, 'not-a-date'));
  assert.throws(() => historyMutationItems('table', { leagueId: 'x'.repeat(2048), reason: 'league-deleted' }, at), /storage budget/);
  const work = JSON.parse(historyMutationItems('table', { leagueId: 'league', reason: 'league-deleted' }, at)[1].Put!.Item!.data.S!);
  assert.equal(historyWorkSchema.safeParse({ ...work, email: 'private@example.test' }).success, false);
  assert.equal(historyWorkSchema.safeParse({ ...work, revision: 'reused-token' }).success, false);
});

function historyCommand() {
  return new TransactWriteItemsCommand({
    ClientRequestToken: 'stable-request-token',
    TransactItems: historyMutationItems('table', { leagueId: 'league', reason: 'goal-changed', gameId: 'game' }, at)
  });
}
const conflict = () => Object.assign(new Error('cancelled'), { name: 'TransactionCanceledException',
  CancellationReasons: [{ Code: 'None' }, { Code: 'TransactionConflict' }] });

test('history transactions retry transient contention using the exact command, source revision and idempotency token', async () => {
  const command = historyCommand(), original = structuredClone(command.input), seen: unknown[] = [], delays: number[] = [];
  const result = { committed: true };
  const client = { async send(value: unknown) {
    seen.push(value);
    if (seen.length === 1) throw conflict();
    if (seen.length === 2) throw Object.assign(new Error('conflict'), { name: 'TransactionConflictException' });
    return result;
  } };
  assert.equal(await sendHistoryTransaction(client, command, { sleep: async ms => { delays.push(ms); }, random: () => 0.5 }), result);
  assert.deepEqual(delays, [25, 50]);
  assert.equal(seen.length, 3);
  assert.ok(seen.every(value => value === command));
  assert.deepEqual(command.input, original, 'retries cannot allocate a fresh source revision or marker');
});

test('history transaction conflict recovery stops after three retries and preserves the final error', async () => {
  const error = conflict(), delays: number[] = []; let attempts = 0;
  await assert.rejects(sendHistoryTransaction({ async send() { attempts++; throw error; } }, historyCommand(), {
    sleep: async ms => { delays.push(ms); }, random: () => 0.5
  }), value => value === error);
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [25, 50, 100]);
});

test('history transaction retries never mask conditions, other cancellations, malformed reasons or ambiguous delivery', async () => {
  const errors = [
    ...['ConditionalCheckFailed', 'ProvisionedThroughputExceeded', 'ValidationError', 'ThrottlingError'].map(Code =>
      Object.assign(new Error(Code), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'TransactionConflict' }, { Code }] })),
    Object.assign(new Error('condition'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] }),
    Object.assign(new Error('unknown'), { name: 'TransactionCanceledException' }),
    Object.assign(new Error('empty'), { name: 'TransactionCanceledException', CancellationReasons: [] }),
    Object.assign(new Error('malformed'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'TransactionConflict' }, null] }),
    Object.assign(new Error('missing code'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'TransactionConflict' }, {}] }),
    Object.assign(new Error('lost ack'), { name: 'TimeoutError' }),
    Object.assign(new Error('validation'), { name: 'ValidationException' }),
    new Error('network connection reset')
  ];
  for (const error of errors) {
    let attempts = 0;
    await assert.rejects(sendHistoryTransaction({ async send() { attempts++; throw error; } }, historyCommand(), {
      sleep: async () => { assert.fail('non-conflict must not be retried'); }
    }), value => value === error);
    assert.equal(attempts, 1, error.message);
  }
});

test('non-history transactions and other SDK commands preserve existing single-send behavior', async () => {
  for (const command of [
    new TransactWriteItemsCommand({ TransactItems: [] }),
    new TransactWriteItemsCommand({ TransactItems: [{ Put: { TableName: 'table', Item: { entityType: { S: 'goal' } } } }] }),
    new GetItemCommand({ TableName: 'table', Key: { pk: { S: 'LEAGUE#league' } } })
  ]) {
    const error = conflict(); let attempts = 0;
    await assert.rejects(sendHistoryTransaction({ async send(value: unknown) {
      attempts++; assert.equal(value, command); throw error;
    } }, command, { sleep: async () => { assert.fail('non-history send must not be retried'); } }), value => value === error);
    assert.equal(attempts, 1);
  }
});
