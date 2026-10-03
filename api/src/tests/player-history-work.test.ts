import assert from 'node:assert/strict';
import test from 'node:test';
import { historyMutationItems, historyMutationReasons, historyWorkSchema, type HistoryMutationInput } from '../data/player-history-work.js';

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
      : reason === 'season-deleted' ? { seasonId: 'winter' } : reason === 'league-deleted' ? {} : { gameId: 'game' };
    const actions = historyMutationItems('table', { leagueId: 'league', reason, ...context }, at);
    assert.equal(historyWorkSchema.parse(JSON.parse(actions[1].Put!.Item!.data.S!)).reason, reason);
    if (reason !== 'league-deleted') assert.throws(() => historyMutationItems('table', { leagueId: 'league', reason }, at));
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
