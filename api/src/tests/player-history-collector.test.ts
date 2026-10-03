import assert from 'node:assert/strict';
import test from 'node:test';
import { GetItemCommand, QueryCommand, TransactWriteItemsCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { ResumableHistoryCollector } from '../data/player-history-collector.js';
import { HistorySource } from '../data/player-history-source.js';
import { historyRow, type HistoryContext, type HistoryItem } from '../data/player-history-model.js';
import { identityGameSk, identityTombstoneSk } from '../data/player-identity.js';
import { goalSk, goalAuditSk } from '../data/keys.js';

const at = '2026-01-01T10:00:00.000Z';
const key = (item: HistoryItem) => JSON.stringify([item.pk!.S, item.sk!.S]);
const value = (item: HistoryItem) => JSON.parse(item.data!.S!) as Record<string, any>;
class MemoryClient {
  items = new Map<string, HistoryItem>();
  queryCount = 0; transactions: TransactWriteItem[][] = [];
  gets: Array<{ pk: string; sk: string }> = [];
  loseNextAcknowledgement = false; failBeforeCommit = false;
  sourcePageLimit = 2; stagedRawPageLimit = 25;
  seed(pk: string, sk: string, type: string, data: unknown, createdAt = at) {
    const item = { ...historyRow(pk, sk, type, data), createdAt: { S: createdAt }, updatedAt: { S: createdAt } };
    this.items.set(key(item), item); return item;
  }
  read(pk: string, sk: string) { return this.items.get(JSON.stringify([pk, sk])); }
  async send(command: unknown): Promise<unknown> {
    if (command instanceof GetItemCommand) {
      assert.equal(command.input.ConsistentRead, true); assert(command.input.Key);
      this.gets.push({ pk: command.input.Key.pk!.S!, sk: command.input.Key.sk!.S! });
      return { Item: structuredClone(this.items.get(key(command.input.Key))) };
    }
    if (command instanceof QueryCommand) {
      this.queryCount++; assert.equal(command.input.ConsistentRead, true);
      const input = command.input, values = input.ExpressionAttributeValues!, pk = values[':pk']!.S!, prefix = values[':prefix']!.S!;
      assert(input.Limit && input.Limit <= 100); const start = input.ExclusiveStartKey?.sk?.S;
      const candidates = [...this.items.values()].filter(item => item.pk!.S === pk && item.sk!.S!.startsWith(prefix)
        && (!start || Buffer.compare(Buffer.from(item.sk!.S!), Buffer.from(start)) > 0))
        .sort((a, b) => Buffer.compare(Buffer.from(a.sk!.S!), Buffer.from(b.sk!.S!)));
      const limit = pk.startsWith('GAME#') ? Math.min(input.Limit, this.sourcePageLimit)
        : prefix.endsWith('#RAW#') ? Math.min(input.Limit, this.stagedRawPageLimit) : input.Limit;
      const rows = candidates.slice(0, limit), last = rows.at(-1);
      return { Items: structuredClone(rows), ...(last && candidates.length > rows.length
        ? { LastEvaluatedKey: { pk: last.pk, sk: last.sk } } : {}) };
    }
    assert(command instanceof TransactWriteItemsCommand); const actions = command.input.TransactItems!;
    this.transactions.push(structuredClone(actions)); assert(actions.length <= 100);
    assert.equal(new Set(actions.map(action => key(action.Put?.Item ?? action.ConditionCheck!.Key!))).size, actions.length);
    const valid = actions.every(action => {
      const operation = action.Put ?? action.ConditionCheck!, item = action.Put?.Item ?? action.ConditionCheck!.Key;
      assert(item); const stored = this.items.get(key(item));
      return operation.ConditionExpression!.split(' AND ').every(clause => {
        const missing = clause.match(/^attribute_not_exists\((.+)\)$/);
        if (missing) return !stored?.[missing[1]];
        const equal = clause.match(/^(\S+) = (\S+)$/); assert(equal, clause);
        return JSON.stringify(stored?.[operation.ExpressionAttributeNames![equal[1]]])
          === JSON.stringify(operation.ExpressionAttributeValues![equal[2]]);
      });
    });
    if (!valid || this.failBeforeCommit) throw Object.assign(new Error('Condition failed'), {
      name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
    });
    for (const action of actions) if (action.Put) { assert(action.Put.Item); this.items.set(key(action.Put.Item), structuredClone(action.Put.Item)); }
    if (this.loseNextAcknowledgement) { this.loseNextAcknowledgement = false; throw Object.assign(new Error('lost acknowledgement'), { name: 'TimeoutError' }); }
    return {};
  }
}

async function fixture() {
  const client = new MemoryClient();
  client.seed('PLAYER_IDENTITY', 'CONTROL', 'playerIdentityControl', { mode: 'fenced', coverage: 'unknown', epoch: 'e1', writerVersion: 1 });
  client.seed('PLAYER_HISTORY', 'CONTROL', 'playerHistoryReadiness', {
    version: 1, enabled: true, revision: '11111111-1111-4111-8111-111111111111', ruleVersion: 1, activatedAt: at,
    manifest: { version: 1, writerVersion: 1, writerSha: 'a'.repeat(40), tableName: 'table', accountId: '123456789012',
      region: 'ap-southeast-2', reviewedPlan: 'https://github.com/ajfisher/3fc/pull/207', drainedAt: at, ruleVersion: 1 },
  });
  client.seed('LEAGUE#league', 'METADATA', 'league', { leagueId: 'league' });
  client.seed('LEAGUE#league', 'HISTORY_SOURCE', 'playerHistorySource', { leagueId: 'league', version: 1, revision: 'r1' });
  for (const id of ['root', 'alias', 'blue', 'yellow']) client.seed(`PLAYER#${id}`, 'IDENTITY', 'playerIdentity', {
    playerId: id, rootId: id === 'alias' ? 'root' : id, members: id === 'alias' ? [] : id === 'root' ? ['root', 'alias'] : [id],
    writeVersion: 'w1', identityVersion: 1, displayName: id, formerNames: [],
  });
  client.seed('PLAYER#alias', identityGameSk('game'), 'playerGameMembership', {
    playerId: 'alias', gameId: 'game', leagueId: 'league', seasonId: 'winter', gameStartTs: '2025-12-31T10:00:00.000Z',
  });
  const teams = ([['red', 3, 0, 'win'], ['blue', 0, 3, 'loss'], ['yellow', 0, 0, 'loss']] as const)
    .map(([teamId, scored, conceded, outcome]) => ({ teamId, scored, conceded, outcome }));
  client.seed('GAME#game', 'METADATA', 'game', { gameId: 'game', leagueId: 'league', seasonId: 'winter', gameStartTs: at,
    status: 'finished', finishedAt: '2026-01-01T11:00:00.000Z', thirdLengthMinutes: 20,
    thirds: [1, 2, 3].map(third => ({ third, startedAt: `2026-01-01T10:${String((third - 1) * 20).padStart(2, '0')}:00.000Z`,
      finishedAt: third === 3 ? '2026-01-01T11:00:00.000Z' : `2026-01-01T10:${third * 20}:00.000Z` })),
    result: { winnerTeamId: 'red', outcome: 'win', comparator: 'fewest_conceded_then_most_scored', teams } });
  for (const team of teams) {
    const id = team.teamId === 'red' ? 'alias' : team.teamId;
    client.seed('GAME#game', `TEAM#${team.teamId}`, 'gameTeam', { gameId: 'game', ...team });
    client.seed('GAME#game', `ROSTER#${team.teamId}#${id}`, 'roster', { gameId: 'game', teamId: team.teamId, playerId: id });
  }
  for (let i = 0; i < 3; i++) {
    const createdAt = `2026-01-01T10:01:0${i}.000Z`, eventId = `goal-${i}`;
    const goal = { gameId: 'game', eventId, scorerPlayerId: 'alias', assistPlayerIds: ['blue'], third: 1,
      elapsedSeconds: 60 + i, gameMinute: 2, thirdMinute: 2, ownGoal: false, scoringTeamId: 'red', concedingTeamId: 'blue' };
    client.seed('GAME#game', goalSk(1, 2, 60 + i, eventId), 'goal', goal, createdAt);
    client.seed('GAME#game', goalAuditSk(createdAt, `audit-${i}`), 'goalAudit', {
      auditId: `audit-${i}`, gameId: 'game', eventId, action: 'goal_created', after: goal,
    }, createdAt);
  }
  const context = await new HistorySource(client, 'table').captureContext('league', 'alias');
  return { client, context, collector: new ResumableHistoryCollector(client, 'table', 'generation') };
}

async function collect(collector: ResumableHistoryCollector, context: HistoryContext, start: string | null = null) {
  let cursor = start; const matches = []; let calls = 0;
  do {
    assert(++calls < 100, 'fixture collection must be bounded');
    const page = await collector.readPage({ context, memberId: 'alias', cursor, limit: 5 });
    assert(page.matches.length <= 1); matches.push(...page.matches); cursor = page.cursor;
  } while (cursor);
  return matches;
}

const putRows = (actions: TransactWriteItem[], entity: string) => actions.flatMap(action =>
  action.Put?.Item?.entityType?.S === entity ? [action.Put.Item] : []);
const resolveTransactions = (client: MemoryClient) => client.transactions.filter(actions =>
  putRows(actions, 'playerHistoryCollectionResolved').length > 0);

async function reachResolve(client: MemoryClient, collector: ResumableHistoryCollector, context: HistoryContext) {
  let cursor: string | null = null;
  for (let step = 0; step < 100; step++) {
    const page = await collector.readPage({ context, memberId: 'alias', cursor, limit: 5 });
    assert(page.cursor); cursor = page.cursor;
    const receipts = [...client.items.values()].filter(item => item.entityType!.S === 'playerHistoryCollectionReceipt');
    if (value(receipts.at(-1)!).next.phase === 'resolve') return cursor;
  }
  throw new Error('Did not reach resolution');
}

test('resolution batches repeated credits and caches canonical identities rather than resolving every raw row', async () => {
  const { client, context, collector } = await fixture(); client.sourcePageLimit = 25;
  const exemplar = [...client.items.values()].find(item => item.entityType!.S === 'goal')!;
  for (let i = 3; i < 40; i++) client.seed('GAME#game', goalSk(1, 2, 60 + i, `goal-${i}`), 'goal',
    { ...value(exemplar), eventId: `goal-${i}`, elapsedSeconds: 60 + i });
  for (const teamId of ['red', 'blue']) {
    const item = client.read('GAME#game', `TEAM#${teamId}`)!;
    item.data = { S: JSON.stringify({ ...value(item), [teamId === 'red' ? 'scored' : 'conceded']: 40 }) };
  }
  const game = client.read('GAME#game', 'METADATA')!, gameData = value(game);
  gameData.result.teams = gameData.result.teams.map((team: any) => ({ ...team,
    ...(team.teamId === 'red' ? { scored: 40 } : team.teamId === 'blue' ? { conceded: 40 } : {}) }));
  game.data = { S: JSON.stringify(gameData) };
  const identityReadsBefore = client.gets.filter(item => item.pk.startsWith('PLAYER#') && item.sk === 'IDENTITY').length;
  const matches = await collect(collector, context);
  assert.equal(matches[0].goals.length, 40);
  const batches = resolveTransactions(client);
  assert.deepEqual(batches.map(actions => putRows(actions, 'playerHistoryCollectionResolved').length), [25, 24]);
  assert.equal(batches.flatMap(actions => putRows(actions, 'playerHistoryCollectionCanonical')).length, 3);
  assert.equal(client.gets.filter(item => item.pk.startsWith('PLAYER#') && item.sk === 'IDENTITY').length - identityReadsBefore, 5,
    'one alias closure and two direct roots, regardless of repeated scorer/assist credits');
  assert(batches.every(actions => actions.length <= 70));
});

test('resolution caps cold identities at four and always advances complete rows', async () => {
  const { client, context, collector } = await fixture(); client.sourcePageLimit = 25;
  for (let i = 0; i < 9; i++) {
    const id = `extra-${i}`;
    client.seed(`PLAYER#${id}`, 'IDENTITY', 'playerIdentity', { playerId: id, rootId: id, members: [id],
      writeVersion: 'w1', identityVersion: 1, displayName: id, formerNames: [] });
    client.seed('GAME#game', `ROSTER#red#${id}`, 'roster', { gameId: 'game', teamId: 'red', playerId: id });
  }
  const matches = await collect(collector, context); assert.equal(matches[0].roster.length, 12);
  const batches = resolveTransactions(client);
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map(actions => putRows(actions, 'playerHistoryCollectionCanonical').length), [4, 4, 4]);
  assert(batches.every(actions => putRows(actions, 'playerHistoryCollectionResolved').length >= 1));
});

test('byte-limited raw pages remain complete and resolution receipts atomically replay caches and rows', async () => {
  const { client, context, collector } = await fixture(); client.stagedRawPageLimit = 2;
  const cursor = await reachResolve(client, collector, context);
  client.loseNextAcknowledgement = true;
  await assert.rejects(collector.readPage({ context, memberId: 'alias', cursor, limit: 5 }), /lost acknowledgement/);
  const queries = client.queryCount, gets = client.gets.length, transactions = client.transactions.length;
  const replay = await collector.readPage({ context, memberId: 'alias', cursor, limit: 5 });
  assert.equal(client.queryCount, queries); assert.equal(client.gets.length, gets + 1); assert.equal(client.transactions.length, transactions);
  assert.equal((await collect(collector, context, replay.cursor)).length, 1);
  assert.deepEqual(resolveTransactions(client).map(actions => putRows(actions, 'playerHistoryCollectionResolved').length), [2, 2, 2, 2, 2, 2]);
  assert.equal([...client.items.values()].filter(item => item.entityType!.S === 'playerHistoryCollectionCanonical').length, 3);
});

test('canonical caches cannot leak across a changed source context in the same generation', async () => {
  const { client, context, collector } = await fixture(); await collect(collector, context);
  client.seed('PLAYER#blue', 'IDENTITY', 'playerIdentity', { playerId: 'blue', rootId: 'new-blue', members: [],
    writeVersion: 'w2', identityVersion: 2, displayName: 'blue', formerNames: [] });
  client.seed('PLAYER#new-blue', 'IDENTITY', 'playerIdentity', { playerId: 'new-blue', rootId: 'new-blue', members: ['new-blue', 'blue'],
    writeVersion: 'w2', identityVersion: 2, displayName: 'blue', formerNames: [] });
  client.seed('LEAGUE#league', 'HISTORY_SOURCE', 'playerHistorySource', { leagueId: 'league', version: 1, revision: 'r2' });
  const revised = await new HistorySource(client, 'table').captureContext('league', 'alias');
  const matches = await collect(collector, revised);
  assert(matches[0].goals.every(goal => goal.assistPlayerIds[0] === 'new-blue'));
  const mappings = [...client.items.values()].filter(item => item.entityType!.S === 'playerHistoryCollectionCanonical')
    .map(value).filter(mapping => mapping.originalId === 'blue');
  assert.deepEqual(mappings.map(mapping => mapping.canonicalId).sort(), ['blue', 'new-blue']);
});

test('failed and duplicate resolution deliveries commit each mapping and resolved row exactly once', async () => {
  const { client, context, collector } = await fixture();
  const cursor = await reachResolve(client, collector, context);
  const request = { context, memberId: 'alias', cursor, limit: 5 };
  client.failBeforeCommit = true;
  await assert.rejects(collector.readPage(request), /changed/);
  assert.equal([...client.items.values()].filter(item => ['playerHistoryCollectionCanonical', 'playerHistoryCollectionResolved']
    .includes(item.entityType!.S!)).length, 0);
  client.failBeforeCommit = false;
  const [one, two] = await Promise.all([collector.readPage(request), collector.readPage(request)]);
  assert.deepEqual(one, two);
  assert.equal([...client.items.values()].filter(item => item.entityType!.S === 'playerHistoryCollectionCanonical').length, 3);
  assert.equal([...client.items.values()].filter(item => item.entityType!.S === 'playerHistoryCollectionResolved').length, 12);
  assert.equal((await collect(collector, context, one.cursor)).length, 1);
});

test('canonical cache is reused across matches within the captured member context', async () => {
  const { client, context, collector } = await fixture();
  for (const item of [...client.items.values()].filter(item => item.pk!.S === 'GAME#game')) {
    const data = value(item); data.gameId = 'game-two';
    if (data.after) data.after.gameId = 'game-two';
    client.seed('GAME#game-two', item.sk!.S!, item.entityType!.S!, data, item.createdAt!.S!);
  }
  client.seed('PLAYER#alias', identityGameSk('game-two'), 'playerGameMembership', {
    playerId: 'alias', gameId: 'game-two', leagueId: 'league', seasonId: 'winter', gameStartTs: at,
  });
  const before = client.gets.filter(item => item.pk.startsWith('PLAYER#') && item.sk === 'IDENTITY').length;
  assert.equal((await collect(collector, context)).length, 2);
  assert.equal(client.gets.filter(item => item.pk.startsWith('PLAYER#') && item.sk === 'IDENTITY').length - before, 5);
  assert.equal([...client.items.values()].filter(item => item.entityType!.S === 'playerHistoryCollectionCanonical').length, 3);
});

test('resumable collection exhausts every raw partition and resolves aliases using current metadata order', async () => {
  const { client, context, collector } = await fixture();
  const matches = await collect(collector, context); assert.equal(matches.length, 1);
  assert.equal(matches[0].kickoffAt, at, 'retained reverse kickoff is not authoritative');
  assert.equal(matches[0].goals.length, 3); assert(matches[0].goals.every(goal => goal.scorerPlayerId === 'root' && goal.timing === 'live'));
  assert.equal(matches[0].roster.length, 3); assert.equal(matches[0].roster.find(player => player.teamId === 'red')?.playerId, 'root');
  assert.equal([...client.items.values()].filter(item => item.entityType!.S === 'playerHistoryCollectionRaw').length, 12);
});

test('lost acknowledgements and concurrent cursor delivery reuse immutable receipts and raw pages', async () => {
  const { client, context, collector } = await fixture();
  client.loseNextAcknowledgement = true;
  await assert.rejects(collector.readPage({ context, memberId: 'alias', cursor: null, limit: 5 }), /lost acknowledgement/);
  const queries = client.queryCount;
  const replay = await collector.readPage({ context, memberId: 'alias', cursor: null, limit: 5 });
  assert.equal(client.queryCount, queries, 'receipt replay never repeats the reference read'); assert(replay.cursor);
  const request = { context, memberId: 'alias', cursor: replay.cursor, limit: 5 };
  const [one, two] = await Promise.all([collector.readPage(request), collector.readPage(request)]);
  assert.deepEqual(one, two);
  assert.equal([...client.items.values()].filter(item => item.entityType!.S === 'playerHistoryCollectionRaw').length, 2);
  assert.equal((await collect(collector, context, one.cursor)).length, 1);
});

test('failed checkpoint writes retain no partial source pages and source changes fence continuations', async () => {
  const { client, context, collector } = await fixture();
  const first = await collector.readPage({ context, memberId: 'alias', cursor: null, limit: 5 });
  client.failBeforeCommit = true;
  await assert.rejects(collector.readPage({ context, memberId: 'alias', cursor: first.cursor, limit: 5 }), /changed/);
  assert.equal([...client.items.values()].filter(item => item.entityType!.S === 'playerHistoryCollectionRaw').length, 0);
  client.failBeforeCommit = false;
  client.seed('LEAGUE#league', 'HISTORY_SOURCE', 'playerHistorySource', { leagueId: 'league', version: 1, revision: 'r2' });
  await assert.rejects(collector.readPage({ context, memberId: 'alias', cursor: first.cursor, limit: 5 }), /changed/);
});

test('collection cursors bind generation, identity, member, readiness and source revisions', async () => {
  const { client, context, collector } = await fixture();
  const first = await collector.readPage({ context, memberId: 'alias', cursor: null, limit: 5 });
  for (const overrides of [{ sourceRevision: 'r2' }, { identityWriteVersion: 'w2' }, { identityEpoch: 'e2' }, { readinessRevision: 'ready2' }, { ruleVersion: 2 }])
    await assert.rejects(collector.readPage({ context: { ...context, ...overrides }, memberId: 'alias', cursor: first.cursor, limit: 5 }), /continuation/);
  await assert.rejects(collector.readPage({ context, memberId: 'root', cursor: first.cursor, limit: 5 }), /continuation/);
  await assert.rejects(new ResumableHistoryCollector(client, 'table', 'other').readPage({ context, memberId: 'alias', cursor: first.cursor, limit: 5 }), /continuation/);
});

test('empty filtered reverse pages retain continuation and canonical roster collisions are rejected', async () => {
  const { client, context, collector } = await fixture();
  let other = '';
  for (let index = 0; index < 100; index++) {
    const candidate = `other-${index}`;
    if (identityGameSk(candidate) < identityGameSk('game')) { other = candidate; break; }
  }
  assert(other);
  client.seed('PLAYER#alias', identityGameSk(other), 'playerGameMembership', {
    playerId: 'alias', gameId: other, leagueId: 'elsewhere', seasonId: 'winter', gameStartTs: at,
  });
  const first = await collector.readPage({ context, memberId: 'alias', cursor: null, limit: 5 });
  assert.deepEqual(first.matches, []); assert(first.cursor);
  assert.equal((await collect(collector, context, first.cursor)).length, 1);
  const duplicate = await fixture();
  duplicate.client.seed('GAME#game', 'ROSTER#red#root', 'roster', { gameId: 'game', teamId: 'red', playerId: 'root' });
  await assert.rejects(collect(duplicate.collector, duplicate.context), /Duplicate or conflicting canonical roster/);
});

test('deleted and unfinished references can be skipped, but unexplained missing games cannot', async () => {
  for (const scenario of ['game', 'season', 'league', 'live', 'missing'] as const) {
    const { client, context, collector } = await fixture();
    if (scenario === 'live') { const item = client.read('GAME#game', 'METADATA')!; item.data = { S: JSON.stringify({ ...value(item), status: 'live' }) }; }
    else {
      client.items.delete(JSON.stringify(['GAME#game', 'METADATA']));
      if (scenario !== 'missing') {
        const ids = scenario === 'game' ? ['game'] : scenario === 'season' ? ['league', 'winter'] : ['league'];
        client.seed('PLAYER_IDENTITY_TOMBSTONE', identityTombstoneSk(scenario, ids), 'playerIdentityTombstone', {
          kind: scenario, ids, ...(scenario === 'game' ? { game: { gameId: 'game', leagueId: 'league', seasonId: 'winter', gameStartTs: at } } : {}),
        });
      }
    }
    if (scenario === 'missing') await assert.rejects(collect(collector, context), /missing without deletion/);
    else if (scenario === 'league') await assert.rejects(collect(collector, context), /changed/, 'league tombstone fails the captured live-league fence');
    else assert.deepEqual(await collect(collector, context), []);
  }
});

test('partial staged coverage, malformed tombstones and assembly budgets fail explicitly', async () => {
  const broken = await fixture();
  broken.client.seed('PLAYER_IDENTITY_TOMBSTONE', identityTombstoneSk('game', ['game']), 'playerIdentityTombstone', {
    kind: 'game', ids: ['game'], game: { gameId: 'game', leagueId: 'wrong', seasonId: 'winter', gameStartTs: at },
  });
  await assert.rejects(collect(broken.collector, broken.context), /scope mismatch/);
  for (const field of ['rows', 'bytes'] as const) {
    const { client, context, collector } = await fixture();
    const first = await collector.readPage({ context, memberId: 'alias', cursor: null, limit: 5 });
    const receipt = [...client.items.values()].find(item => item.entityType!.S === 'playerHistoryCollectionReceipt')!, data = value(receipt);
    data.next[field] = field === 'rows' ? 10_000 : 8 * 1024 * 1024;
    receipt.data = { S: JSON.stringify(data) };
    await assert.rejects(collector.readPage({ context, memberId: 'alias', cursor: first.cursor, limit: 5 }), /assembly budget/);
  }
  const partial = await fixture(); let cursor: string | null = null;
  for (;;) {
    const page = await partial.collector.readPage({ context: partial.context, memberId: 'alias', cursor, limit: 5 });
    cursor = page.cursor; assert(cursor);
    const receipts = [...partial.client.items.values()].filter(item => item.entityType!.S === 'playerHistoryCollectionReceipt');
    const next = value(receipts.at(-1)!).next;
    if (next.phase === 'emit') break;
  }
  const resolved = [...partial.client.items.values()].find(item => item.entityType!.S === 'playerHistoryCollectionResolved')!;
  partial.client.items.delete(key(resolved));
  await assert.rejects(partial.collector.readPage({ context: partial.context, memberId: 'alias', cursor, limit: 5 }), /Malformed history record|coverage/);
});
