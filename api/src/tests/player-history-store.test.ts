import assert from 'node:assert/strict';
import test from 'node:test';
import { GetItemCommand, QueryCommand, TransactWriteItemsCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { PlayerHistoryStore, type HistoryCollector } from '../data/player-history-store.js';
import { historyKey, historyPartition, historyRow, type HistoryGeneration, type HistoryItem } from '../data/player-history-model.js';
import type { MatchFacts } from '../achievements/evaluate.js';

const player = 'canonical/player';
const lookup = (item: HistoryItem): string => JSON.stringify([item.pk!.S, item.sk!.S]);
function fixture() {
  const items = new Map<string, HistoryItem>();
  const source = historyRow('LEAGUE#league', 'HISTORY_SOURCE', 'historySource', { revision: 'source-1' });
  items.set(lookup(source), source);
  let fail: ((actions: TransactWriteItem[]) => boolean) | null = null;
  let loseAck: ((actions: TransactWriteItem[]) => boolean) | null = null;
  const transactions: TransactWriteItem[][] = [];
  const queries: QueryCommand['input'][] = [];
  const client = { async send(command: unknown) {
    if (command instanceof GetItemCommand) {
      assert.equal(command.input.ConsistentRead, true);
      const item = items.get(lookup(command.input.Key!));
      return item ? { Item: structuredClone(item) } : {};
    }
    if (command instanceof QueryCommand) {
      queries.push(command.input);
      assert.equal(command.input.ConsistentRead, true);
      assert(Number.isInteger(command.input.Limit) && command.input.Limit! <= 20);
      assert.equal(command.input.IndexName, undefined);
      const pk = command.input.ExpressionAttributeValues![':pk'].S!, prefix = command.input.ExpressionAttributeValues![':prefix'].S!;
      const last = command.input.ExclusiveStartKey?.sk.S, ascending = command.input.ScanIndexForward !== false;
      const rows = [...items.values()].filter(row => row.pk.S === pk && row.sk.S!.startsWith(prefix) &&
        (!last || (ascending ? row.sk.S! > last : row.sk.S! < last)))
        .sort((a, b) => (a.sk.S! < b.sk.S! ? -1 : a.sk.S! > b.sk.S! ? 1 : 0) * (ascending ? 1 : -1));
      const page = rows.slice(0, command.input.Limit);
      return { Items: structuredClone(page), ...(rows.length > page.length ? {
        LastEvaluatedKey: historyKey(pk, page[page.length - 1].sk.S!) } : {}) };
    }
    assert(command instanceof TransactWriteItemsCommand, 'store performs only bounded reads and transactions');
    const actions = command.input.TransactItems!;
    transactions.push(structuredClone(actions));
    assert(actions.length <= 100);
    assert(Buffer.byteLength(JSON.stringify(actions)) <= 3_500_000);
    if (fail?.(actions)) throw new Error('injected staging failure');
    const conditions = actions.map(action => {
      const op = action.Put ?? action.ConditionCheck!;
      const key = action.Put?.Item ?? action.ConditionCheck!.Key;
      assert(key);
      const prior = items.get(lookup(key));
      const expression = op.ConditionExpression;
      if (expression === 'attribute_not_exists(pk)') return !prior;
      if (expression === 'attribute_not_exists(pk) OR #data = :same') return !prior || prior.data.S === op.ExpressionAttributeValues![':same'].S;
      if (expression === '#data = :expected') return prior?.data.S === op.ExpressionAttributeValues![':expected'].S;
      assert.fail(`unrecognised condition ${expression}`);
    });
    if (conditions.some(value => !value)) throw Object.assign(new Error('conditional failure'), {
      name: 'TransactionCanceledException', CancellationReasons: conditions.map(value => ({ Code: value ? 'None' : 'ConditionalCheckFailed' })) });
    for (const action of actions) if (action.Put) {
      assert(action.Put.Item);
      items.set(lookup(action.Put.Item), structuredClone(action.Put.Item));
    }
    if (loseAck?.(actions)) throw new Error('injected lost transaction acknowledgement');
    return {};
  } };
  const spec = (generation = 'generation-1'): HistoryGeneration => ({ generation, calculatedAt: '2026-03-01T00:00:00.000Z',
    context: { leagueId: 'league', playerId: player, members: [player], displayName: 'Player', sourceRevision: 'source-1',
      identityWriteVersion: 'identity-1', identityEpoch: 'epoch-1', checks: [{ ConditionCheck: { TableName: 'fixture',
        Key: historyKey('LEAGUE#league', 'HISTORY_SOURCE'), ConditionExpression: '#data = :expected',
        ExpressionAttributeNames: { '#data': 'data' }, ExpressionAttributeValues: { ':expected': source.data } } }] } });
  return { store: new PlayerHistoryStore(client, 'fixture'), items, transactions, queries, spec,
    failWhen: (predicate: ((actions: TransactWriteItem[]) => boolean) | null) => { fail = predicate; },
    loseAckWhen: (predicate: ((actions: TransactWriteItem[]) => boolean) | null) => { loseAck = predicate; },
    changeSource() { items.set(lookup(source), historyRow('LEAGUE#league', 'HISTORY_SOURCE', 'historySource', { revision: 'source-2' })); } };
}
function facts(number: number, seasonId = 'winter', goals = 1): MatchFacts {
  const day = `2026-01-${String(number).padStart(2, '0')}`;
  return { gameId: `game-${number}`, leagueId: 'league', seasonId, sourceRevision: 'source-1',
    kickoffAt: `${day}T10:00:00.000Z`, finishedAt: `${day}T11:10:00.000Z`, thirdLengthMinutes: 20,
    thirdEndsSeconds: [1200, 1200, 1200], roster: [{ playerId: player, teamId: 'red' }],
    goals: Array.from({ length: goals }, (_, index) => ({ eventId: `goal-${index}`, scorerPlayerId: player,
      assistPlayerIds: [], scoringTeamId: 'red', concedingTeamId: 'blue', ownGoal: false,
      third: 1, elapsedSeconds: 300 + index, createdAt: `${day}T10:10:00.000Z`, timing: 'live' })) };
}
function collector(matches: MatchFacts[]): HistoryCollector {
  return async ({ cursor, limit }) => {
    const offset = cursor === null ? 0 : Number(cursor);
    return { matches: matches.slice(offset, offset + limit), cursor: offset + limit < matches.length ? String(offset + limit) : null };
  };
}
async function complete(store: PlayerHistoryStore, spec: HistoryGeneration, matches: MatchFacts[]) {
  let status = await store.beginGeneration(spec);
  while (status.phase === 'collecting') status = await store.collectNext(spec, collector(matches));
  // The final empty facts query is the persisted exhaustion proof.
  for (let index = 0; index <= matches.length; index++) await store.evaluateNext(spec);
  await store.markComplete(spec);
}

test('completion cannot be asserted before persisted collection and evaluation exhaustion', async () => {
  const f = fixture(), spec = f.spec();
  await f.store.beginGeneration(spec);
  await assert.rejects(f.store.markComplete(spec), /checkpoints/);
  await assert.rejects(f.store.publish(spec), /coverage/);
  await assert.rejects(f.store.evaluateNext(spec), /Collection coverage/);
  await f.store.collectNext(spec, collector([facts(1)]));
  await assert.rejects(f.store.markComplete(spec), /checkpoints/);
  await f.store.evaluateNext(spec);
  await assert.rejects(f.store.markComplete(spec), /checkpoints/, 'one evaluated row is not proof there are no more rows');
  await f.store.evaluateNext(spec);
  await f.store.markComplete(spec);
  assert.equal((await f.store.publish(spec)).generation, spec.generation);
});

test('verified empty history publishes explicit zero while absent publication remains unavailable', async () => {
  const f = fixture(), spec = f.spec();
  assert.equal(await f.store.getSummary('league', player, { scope: 'career', seasonId: null }), null);
  await complete(f.store, spec, []);
  const publication = await f.store.publish(spec);
  assert.equal(publication.latest, null); assert.deepEqual(publication.seasons, []);
  assert.equal((await f.store.getSummary('league', player, { scope: 'career', seasonId: null }))?.state.totals.played, 0);
  assert.deepEqual(await f.store.pageMatches({ leagueId: 'league', playerId: player }), { items: [], cursor: null });
});

test('all members must be exhausted and source order is rebuilt chronologically for evaluation', async () => {
  const f = fixture(), spec = f.spec(); spec.context.members.push('alias');
  await f.store.beginGeneration(spec);
  const read: HistoryCollector = async ({ memberId }) => ({ matches: [facts(memberId === player ? 2 : 1)], cursor: null });
  assert.equal((await f.store.collectNext(spec, read)).phase, 'collecting');
  await assert.rejects(f.store.markComplete(spec));
  assert.equal((await f.store.collectNext(spec, read)).phase, 'evaluating');
  for (let index = 0; index < 3; index++) await f.store.evaluateNext(spec);
  await f.store.markComplete(spec); await f.store.publish(spec);
  const summary = await f.store.getSummary('league', player, { scope: 'career', seasonId: null });
  assert.equal(summary?.state.totals.played, 2);
  assert.equal(summary?.state.highest.goal?.gameId, 'game-1', 'the earlier alias match earned the first milestone');
});

test('collection refuses duplicate canonical matches across pages and cannot replace immutable facts', async () => {
  const f = fixture(), spec = f.spec();
  await f.store.beginGeneration(spec);
  await f.store.collectNext(spec, async () => ({ matches: [facts(1)], cursor: 'next' }));
  await assert.rejects(f.store.collectNext(spec, async () => ({ matches: [facts(1)], cursor: null })), /History changed/);
  await assert.rejects(f.store.markComplete(spec));
  await assert.rejects(f.store.beginGeneration({ ...spec, context: { ...spec.context, sourceRevision: 'replacement' } }), /Malformed/);
});

test('collection rejects mismatched source revision and non-progressing source cursors', async () => {
  const f = fixture(), spec = f.spec();
  await f.store.beginGeneration(spec);
  await assert.rejects(f.store.collectNext(spec, collector([{ ...facts(1), sourceRevision: 'stale-source' }])), /crosses scope/);
  await f.store.collectNext(spec, async () => ({ matches: [], cursor: 'page-2' }));
  await assert.rejects(f.store.collectNext(spec, async () => ({ matches: [], cursor: 'page-2' })), /Invalid authoritative/);
  await assert.rejects(f.store.markComplete(spec));
});

test('a changed source fence or previous published pointer prevents stale publication atomically', async () => {
  const f = fixture(), one = f.spec('one'), two = f.spec('two');
  await complete(f.store, one, [facts(1)]); await complete(f.store, two, [facts(2)]);
  await f.store.publish(one);
  await assert.rejects(f.store.publish(two), /History changed/);
  assert.equal((await f.store.getPublication('league', player))?.generation, 'one');
  const three = f.spec('three'); await complete(f.store, three, [facts(3)]);
  f.changeSource();
  await assert.rejects(f.store.publish(three), /History changed/);
  assert.equal((await f.store.getPublication('league', player))?.generation, 'one');
  const audits = [...f.items.values()].filter(item => item.entityType.S === 'playerHistoryPublicationAudit');
  assert.equal(audits.length, 1, 'failed publications cannot append audit or move pointer');
});

test('publication retains prior evidence and stable award IDs through revocation and reinstatement', async () => {
  const f = fixture(), one = f.spec('one');
  await complete(f.store, one, [facts(1)]); await f.store.publish(one);
  const first = await f.store.pageAwards({ leagueId: 'league', playerId: player, scope: { scope: 'career', seasonId: null } });
  const award = first!.items.find(value => value.achievementId === 'goal')!;
  const two = f.spec('two'); await complete(f.store, two, [facts(1, 'winter', 0)]); await f.store.publish(two);
  assert.equal((await f.store.pageAwards({ leagueId: 'league', playerId: player, scope: { scope: 'career', seasonId: null } }))!.items.some(value => value.achievementId === 'goal'), false);
  const three = f.spec('three'); await complete(f.store, three, [facts(1)]); await f.store.publish(three);
  const restored = (await f.store.pageAwards({ leagueId: 'league', playerId: player, scope: { scope: 'career', seasonId: null } }))!.items.find(value => value.achievementId === 'goal')!;
  assert.equal(restored.id, award.id);
  assert.equal((await f.store.getPublication('league', player))?.previousGeneration, 'two');
  assert.equal([...f.items.values()].filter(item => item.entityType.S === 'playerHistoryPublicationAudit').length, 3);
  assert.equal([...f.items.values()].filter(item => item.entityType.S === 'playerHistoryAward' && JSON.parse(item.data.S!).id === award.id).length, 2);
  assert.equal([...f.items.values()].some(item => 'ttlEpoch' in item), false);
});

test('public history is bounded newest-first, season-indexed and rejects cross-scope or stale continuations', async () => {
  const f = fixture(), spec = f.spec();
  await complete(f.store, spec, Array.from({ length: 23 }, (_, index) => facts(index + 1, index % 2 ? 'summer' : 'winter')));
  await f.store.publish(spec);
  const first = await f.store.pageMatches({ leagueId: 'league', playerId: player });
  assert.equal(first!.items.length, 20); assert.equal(first!.items[0].gameId, 'game-23'); assert(first!.cursor);
  const second = await f.store.pageMatches({ leagueId: 'league', playerId: player, cursor: first!.cursor! });
  assert.deepEqual(second!.items.map(value => value.gameId), ['game-3', 'game-2', 'game-1']);
  assert.equal(second!.cursor, null);
  const season = await f.store.pageMatches({ leagueId: 'league', playerId: player, seasonId: 'summer' });
  assert.equal(season!.items.length, 11); assert(season!.items.every(value => value.seasonId === 'summer'));
  await assert.rejects(f.store.pageMatches({ leagueId: 'league', playerId: player, seasonId: 'summer', cursor: first!.cursor! }), /continuation/);
  await assert.rejects(f.store.pageAwards({ leagueId: 'league', playerId: player, scope: { scope: 'career', seasonId: null }, cursor: first!.cursor! }), /continuation/);
  await assert.rejects(f.store.pageMatches({ leagueId: 'other', playerId: player, cursor: first!.cursor! }), /continuation/);
  await assert.rejects(f.store.pageMatches({ leagueId: 'league', playerId: player, cursor: 'not-json' }), /continuation/);
  const next = f.spec('next'); await complete(f.store, next, [facts(1)]); await f.store.publish(next);
  await assert.rejects(f.store.pageMatches({ leagueId: 'league', playerId: player, cursor: first!.cursor! }), /continuation/);
  assert(f.queries.some(query => query.ScanIndexForward === false && query.ExpressionAttributeValues![':prefix'].S!.includes('SEASON#')));
});

test('partial award staging does not advance evaluation and retries preserve all milestones', async () => {
  const f = fixture(), spec = f.spec();
  const game = facts(1, 'winter', 60);
  game.goals = game.goals.map(goal => ({ ...goal, ownGoal: true, scoringTeamId: null, concedingTeamId: 'red' }));
  await f.store.beginGeneration(spec); await f.store.collectNext(spec, collector([game]));
  let awardChunks = 0;
  f.failWhen(actions => actions.some(action => action.Put?.Item?.entityType.S === 'playerHistoryAward') && ++awardChunks === 2);
  await assert.rejects(f.store.evaluateNext(spec), /injected staging failure/);
  await assert.rejects(f.store.markComplete(spec));
  f.failWhen(null);
  await f.store.evaluateNext(spec); await f.store.evaluateNext(spec); await f.store.markComplete(spec); await f.store.publish(spec);
  const awards: string[] = []; let cursor: string | undefined;
  do {
    const page = await f.store.pageAwards({ leagueId: 'league', playerId: player, scope: { scope: 'career', seasonId: null }, cursor });
    awards.push(...page!.items.filter(value => value.achievementId === 'own-goal').map(value => value.id));
    cursor = page!.cursor ?? undefined;
  } while (cursor);
  assert.equal(awards.length, 60); assert.equal(new Set(awards).size, 60);
  assert.equal((await f.store.getSummary('league', player, { scope: 'career', seasonId: null }))?.state.totals.played, 1);
  assert(f.transactions.every(actions => actions.length <= 100));
});

test('unassigned registrations advance evaluation without adding an appearance or breaking runs', async () => {
  const f = fixture(), spec = f.spec();
  const missed = { ...facts(2), roster: [], goals: [] };
  await complete(f.store, spec, [facts(1), missed, facts(3)]); await f.store.publish(spec);
  const summary = await f.store.getSummary('league', player, { scope: 'career', seasonId: null });
  assert.equal(summary!.state.totals.played, 2); assert.equal(summary!.state.runs['on-fire'], 2);
  assert.deepEqual((await f.store.pageMatches({ leagueId: 'league', playerId: player }))!.items.map(value => value.gameId), ['game-3', 'game-1']);
  assert.equal(historyPartition('league', player).startsWith('PLAYER_HISTORY#'), true);
});

test('concurrent evaluation of one checkpoint advances once and preserves unique milestones', async () => {
  const f = fixture(), spec = f.spec();
  await f.store.beginGeneration(spec); await f.store.collectNext(spec, collector([facts(1)]));
  const results = await Promise.allSettled([f.store.evaluateNext(spec), f.store.evaluateNext(spec)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert(rejected?.status === 'rejected'); assert.equal(rejected.reason.code, 'history_changed');
  await f.store.evaluateNext(spec); await f.store.markComplete(spec); await f.store.publish(spec);
  const summary = await f.store.getSummary('league', player, { scope: 'career', seasonId: null });
  assert.equal(summary!.state.totals.played, 1); assert.equal(summary!.state.totals.goals, 1);
  const awards = (await f.store.pageAwards({ leagueId: 'league', playerId: player, scope: { scope: 'career', seasonId: null } }))!.items;
  assert.equal(awards.filter(value => value.achievementId === 'goal').length, 1);
});

test('lost acknowledgements resume from committed collection and evaluation checkpoints', async () => {
  const f = fixture(), spec = f.spec();
  await f.store.beginGeneration(spec);
  const losesPhase = (phase: string, evaluated: number) => (actions: TransactWriteItem[]) => actions.some(action => {
    const item = action.Put?.Item;
    if (item?.entityType.S !== 'playerHistoryGeneration') return false;
    const record = JSON.parse(item.data.S!);
    return record.phase === phase && record.evaluated === evaluated;
  });
  f.loseAckWhen(losesPhase('evaluating', 0));
  await assert.rejects(f.store.collectNext(spec, collector([facts(1), facts(2)])), /lost transaction acknowledgement/);
  f.loseAckWhen(null);
  assert.equal((await f.store.collectNext(spec, async () => assert.fail('committed page must not be collected again'))).phase, 'evaluating');
  f.loseAckWhen(losesPhase('evaluating', 1));
  await assert.rejects(f.store.evaluateNext(spec), /lost transaction acknowledgement/);
  f.loseAckWhen(null);
  await f.store.evaluateNext(spec); await f.store.evaluateNext(spec); await f.store.markComplete(spec); await f.store.publish(spec);
  assert.equal((await f.store.getSummary('league', player, { scope: 'career', seasonId: null }))!.state.totals.played, 2);
  assert.deepEqual((await f.store.pageMatches({ leagueId: 'league', playerId: player }))!.items.map(value => value.gameId), ['game-2', 'game-1']);
});
