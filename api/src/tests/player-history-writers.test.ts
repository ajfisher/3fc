import assert from 'node:assert/strict';
import test from 'node:test';
import { GetItemCommand, QueryCommand, ScanCommand, PutItemCommand, DeleteItemCommand,
  TransactGetItemsCommand, TransactWriteItemsCommand, type AttributeValue, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { ThreeFcRepository } from '../data/repository.js';
import { identityDirectorySk, identityItem } from '../data/player-identity.js';

type Item = Record<string, AttributeValue>;
const at = '2026-10-03T11:05:00.000Z';
const key = (item: Item) => JSON.stringify([item.pk!.S, item.sk!.S]);
const body = (item: Item) => JSON.parse(item.data!.S!) as Record<string, any>;

/** Small transactional fake: checks every condition before applying any write, and can reject
 * the exact transaction containing history work. No separate-write history implementation passes. */
class WriterClient {
  items = new Map<string, Item>();
  transactions: TransactWriteItem[][] = [];
  failHistory = false;
  conflictHistory = 0;
  seed(pk: string, sk: string, type: string, data: unknown) { const item = identityItem(pk, sk, type, data, at); this.items.set(key(item), item); }
  read(pk: string, sk: string) { return this.items.get(JSON.stringify([pk, sk])); }
  conditions(expression: string | undefined, item: Item | undefined, names: Record<string, string> = {}, values: Record<string, AttributeValue> = {}) {
    if (!expression) return true;
    return expression.split(/\s+AND\s+/).every(clause => {
      const absent = clause.match(/^attribute_not_exists\(([^)]+)\)$/);
      if (absent) return item?.[names[absent[1]] ?? absent[1]] === undefined;
      const present = clause.match(/^attribute_exists\(([^)]+)\)$/);
      if (present) return item?.[names[present[1]] ?? present[1]] !== undefined;
      const equal = clause.match(/^(.+?)\s*=\s*(.+)$/); assert(equal, `unsupported condition ${clause}`);
      return item?.[names[equal[1]] ?? equal[1]] !== undefined
        && JSON.stringify(item[names[equal[1]] ?? equal[1]]) === JSON.stringify(values[equal[2]]);
    });
  }
  async send(command: unknown): Promise<unknown> {
    if (command instanceof GetItemCommand) return { Item: structuredClone(this.items.get(key(command.input.Key!))) };
    if (command instanceof TransactGetItemsCommand) return { Responses: command.input.TransactItems!.map(action => {
      assert(action.Get?.Key);
      return { Item: structuredClone(this.items.get(key(action.Get.Key))) };
    }) };
    if (command instanceof QueryCommand || command instanceof ScanCommand) {
      const query = command instanceof QueryCommand ? command.input : null;
      const values = query?.ExpressionAttributeValues;
      const pk = values?.[':pk']?.S, prefix = values?.[':skPrefix']?.S ?? values?.[':prefix']?.S ?? '';
      const start = command.input.ExclusiveStartKey;
      const rows = [...this.items.values()].filter(item => !query || (item.pk.S === pk && item.sk.S!.startsWith(prefix)))
        .sort((a, b) => Buffer.compare(Buffer.from(key(a)), Buffer.from(key(b))))
        .filter(item => !start || Buffer.compare(Buffer.from(key(item)), Buffer.from(key(start))) > 0);
      const page = rows.slice(0, command.input.Limit ?? rows.length), last = page.at(-1);
      return { Items: structuredClone(page), ...(last && page.length < rows.length ? { LastEvaluatedKey: { pk: last.pk, sk: last.sk } } : {}) };
    }
    if (command instanceof PutItemCommand) {
      const input = command.input, item = input.Item!;
      assert(this.conditions(input.ConditionExpression, this.items.get(key(item)), input.ExpressionAttributeNames, input.ExpressionAttributeValues));
      this.items.set(key(item), structuredClone(item)); return {};
    }
    if (command instanceof DeleteItemCommand) { this.items.delete(key(command.input.Key!)); return {}; }
    assert(command instanceof TransactWriteItemsCommand);
    const actions = command.input.TransactItems!; this.transactions.push(structuredClone(actions));
    assert(actions.length <= 100);
    assert.equal(new Set(actions.map(action => {
      const itemKey = action.Put?.Item ?? action.Delete?.Key ?? action.ConditionCheck?.Key;
      assert(itemKey); return key(itemKey);
    })).size, actions.length);
    if (this.conflictHistory > 0 && actions.some(action => action.Put?.Item?.entityType?.S === 'playerHistoryWork')) {
      this.conflictHistory--;
      throw Object.assign(new Error('Independent league writer contended'), {
        name: 'TransactionCanceledException', CancellationReasons: actions.map(action => ({
          Code: action.Put?.Item?.entityType?.S === 'playerHistorySource' ? 'TransactionConflict' : 'None'
        }))
      });
    }
    const valid = actions.every(action => {
      const op = action.Put ?? action.Delete ?? action.ConditionCheck!;
      const itemKey = action.Put?.Item ?? action.Delete?.Key ?? action.ConditionCheck!.Key;
      assert(itemKey);
      return this.conditions(op.ConditionExpression, this.items.get(key(itemKey)), op.ExpressionAttributeNames, op.ExpressionAttributeValues);
    });
    if (!valid || (this.failHistory && actions.some(action => action.Put?.Item?.entityType?.S === 'playerHistoryWork')))
      throw Object.assign(new Error('Atomic transaction rejected'), { name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ConditionalCheckFailed' }] });
    for (const action of actions) {
      if (action.Put) this.items.set(key(action.Put.Item!), structuredClone(action.Put.Item!));
      if (action.Delete) { assert(action.Delete.Key); this.items.delete(key(action.Delete.Key)); }
    }
    return {};
  }
  work() { return [...this.items.values()].filter(item => item.entityType.S === 'playerHistoryWork').map(body); }
}

function harness(status: 'live' | 'finished' | 'scheduled' = 'finished', includeGame = true) {
  const client = new WriterClient();
  client.seed('PLAYER_IDENTITY', 'CONTROL', 'playerIdentityControl', { mode: 'fenced', coverage: 'verified', epoch: 'e1', writerVersion: 1 });
  client.seed('LEAGUE#league', 'METADATA', 'league', { leagueId: 'league', name: 'League', slug: null, createdByUserId: 'admin' });
  client.seed('LEAGUE#league', 'ACL#USER#admin', 'acl', { leagueId: 'league', userId: 'admin', role: 'admin', grantedByUserId: 'admin' });
  client.seed('LEAGUE#league', 'PLAYER_DIRECTORY', 'playerDirectoryRevision', { revision: 'directory' });
  for (const id of ['red', 'blue', 'yellow', 'late']) {
    client.seed(`PLAYER#${id}`, 'PROFILE', 'player', { playerId: id, nickname: id, claimedByUserId: null });
    client.seed(`PLAYER#${id}`, 'IDENTITY', 'playerIdentity', { playerId: id, rootId: id, members: [id], identityVersion: 1, writeVersion: 'w1', displayName: id, formerNames: [] });
    client.seed('LEAGUE#league', identityDirectorySk(id), 'leaguePlayer', { playerId: id, nickname: id, formerNames: [], active: true, seasonIds: ['winter'], hasMoreSeasons: false });
  }
  const teams = (['red', 'blue', 'yellow'] as const).map(teamId => ({ gameId: 'game', teamId, name: teamId, color: null, scored: 0, conceded: 0, rank: 1, outcome: 'draw' }));
  if (includeGame) {
    client.seed('GAME#game', 'METADATA', 'game', { gameId: 'game', leagueId: 'league', seasonId: 'winter', sessionId: 'session', joinCode: 'ABCDEFGH', status,
      gameStartTs: '2026-10-03T10:00:00.000Z', thirdLengthMinutes: 20,
      thirds: [1, 2, 3].map(third => ({ third, startedAt: `2026-10-03T10:${String((third - 1) * 20).padStart(2, '0')}:00.000Z`,
        finishedAt: third === 3 ? status === 'live' ? null : '2026-10-03T11:00:00.000Z' : `2026-10-03T10:${third * 20}:00.000Z` })),
      finishedAt: status === 'finished' ? '2026-10-03T11:00:00.000Z' : null,
      result: status === 'finished' ? { outcome: 'draw', winnerTeamId: null, comparator: 'fewest_conceded_then_most_scored', computedAt: at, teams } : null });
    client.seed('JOIN_CODE#ABCDEFGH', 'METADATA', 'gameJoinCode', { gameId: 'game', joinCode: 'ABCDEFGH' });
    for (const value of teams) {
      client.seed('GAME#game', `TEAM#${value.teamId}`, 'gameTeam', value);
      client.seed('GAME#game', `ROSTER#${value.teamId}#${value.teamId}`, 'roster', { gameId: 'game', playerId: value.teamId, teamId: value.teamId });
      client.seed('GAME#game', `PLAYER#${value.teamId}`, 'gamePlayer', { gameId: 'game', playerId: value.teamId });
    }
  }
  const repository = new ThreeFcRepository(client, 'fixture', { now: () => at });
  return { repository, client };
}
const goalInput = { gameId: 'game', eventId: 'goal', actorUserId: 'admin', scorerPlayerId: 'red', assistPlayerIds: [],
  scoringTeamId: 'red' as const, concedingTeamId: 'blue' as const, ownGoal: false, allowFinished: true };
function assertAtomic(client: WriterClient, reason: string, domainType: string) {
  const txn = [...client.transactions].reverse().find(actions => actions.some(action => {
    const item = action.Put?.Item;
    return item?.entityType?.S === 'playerHistoryWork' && body(item).reason === reason;
  }));
  assert(txn, `missing ${reason}`);
  assert(txn.some(action => action.Put?.Item?.entityType?.S === domainType || (domainType === 'delete' && action.Delete)));
  const source = txn.find(action => action.Put?.Item?.entityType?.S === 'playerHistorySource')!.Put!.Item!;
  const work = txn.find(action => action.Put?.Item?.entityType?.S === 'playerHistoryWork')!.Put!.Item!;
  assert.equal(body(source).revision, body(work).revision);
  assert.equal(txn.filter(action => action.Put?.Item?.entityType?.S === 'playerHistoryWork').length, 1);
}

function assertPublic(value: unknown) {
  assert(value, 'expected a public response');
  assert.equal(JSON.stringify(value).includes('timingProvenance'), false, 'internal timing provenance must not cross the scoring API boundary');
}

test('normal and legacy completion publish atomic obligations; completed replay publishes nothing', async () => {
  for (const legacy of [false, true]) {
    const { repository, client } = harness(legacy ? 'finished' : 'live');
    const game = client.read('GAME#game', 'METADATA')!, value = body(game);
    value.thirds[2].finishedAt = '2026-10-03T11:00:00.000Z'; if (legacy) value.result = null;
    game.data = { S: JSON.stringify(value) };
    await repository.finishGame({ gameId: 'game' }); assertAtomic(client, 'game-finished', 'game');
    assert.equal(client.work().length, 1);
    await repository.finishGame({ gameId: 'game' }); assert.equal(client.work().length, 1);
  }
});

test('finished goal additions, corrections and deletion commit provenance and work with source data', async () => {
  const { repository, client } = harness();
  assertPublic(await repository.createGoal(goalInput)); assertAtomic(client, 'goal-changed', 'goal');
  await assert.rejects(repository.createGoal(goalInput), /already been created/);
  assert.equal(client.work().length, 1, 'duplicate creation must not publish an obligation');
  assertPublic(await repository.listGoalEvents('game'));
  assertPublic(await repository.listGoalAuditEntries('game'));
  let goal = [...client.items.values()].find(item => item.entityType.S === 'goal')!;
  assert.deepEqual(body(goal).timingProvenance, { version: 1, kind: 'post_completion' });
  const correction = { gameId: 'game', eventId: 'goal', actorUserId: 'admin', assistPlayerIds: ['yellow'], allowFinished: true,
    operationId: 'edit-once', operationRequestHash: 'hash' };
  const updated = await repository.updateGoal(correction); assertPublic(updated); assert.equal(client.work().length, 2);
  goal = [...client.items.values()].find(item => item.entityType.S === 'goal')!;
  assert.deepEqual(body(goal).timingProvenance, { version: 1, kind: 'post_completion' });
  const replayed = await repository.updateGoal(correction); assertPublic(replayed); assert.deepEqual(replayed, updated);
  assert.equal(client.work().length, 2, 'saved replay must not generate work');
  const receipt = [...client.items.values()].find(item => item.entityType.S === 'goalCorrectionOperation')!;
  assert.deepEqual(body(receipt).result.goal.timingProvenance, { version: 1, kind: 'post_completion' });
  await repository.updateGoal({ gameId: 'game', eventId: 'goal', actorUserId: 'admin', allowFinished: true });
  assert.equal(client.work().length, 2, 'unchanged goal credit must not generate work');
  const deletion = { gameId: 'game', eventId: 'goal', actorUserId: 'admin', allowFinished: true,
    operationId: 'delete-once', operationRequestHash: 'delete-hash' };
  const deleted = await repository.deleteGoal(deletion); assertPublic(deleted);
  const deletedReplay = await repository.deleteGoal(deletion); assertPublic(deletedReplay); assert.deepEqual(deletedReplay, deleted);
  assertPublic(await repository.listGoalAuditEntries('game'));
  assertAtomic(client, 'goal-changed', 'goalAudit'); assert.equal(client.work().length, 3);
  for (const audit of [...client.items.values()].filter(item => item.entityType.S === 'goalAudit')) {
    const value = body(audit); assert.deepEqual((value.after ?? value.before).timingProvenance, { version: 1, kind: 'post_completion' });
  }
});

test('live goal changes defer work until completion and legacy corrections never invent provenance', async () => {
  const live = harness('live'); assertPublic(await live.repository.createGoal({ ...goalInput, allowFinished: false }));
  assert.equal(live.client.work().length, 0);
  const stored = [...live.client.items.values()].find(item => item.entityType.S === 'goal')!;
  assert.deepEqual(body(stored).timingProvenance, { version: 1, kind: 'live' });
  const original = body(stored); delete original.timingProvenance; stored.data = { S: JSON.stringify(original) };
  await live.repository.updateGoal({ gameId: 'game', eventId: 'goal', actorUserId: 'admin', assistPlayerIds: ['yellow'] });
  const corrected = [...live.client.items.values()].find(item => item.entityType.S === 'goal')!;
  assert.equal('timingProvenance' in body(corrected), false); assert.equal(live.client.work().length, 0);
  assertPublic(await live.repository.deleteGoal({ gameId: 'game', eventId: 'goal', actorUserId: 'admin' }));
  assert.equal(live.client.work().length, 0);
});

test('finished undo and its saved replay preserve audit evidence while returning the unchanged public shape', async () => {
  const { repository, client } = harness(); await repository.createGoal(goalInput);
  const input = { gameId: 'game', actorUserId: 'admin', expectedEventId: 'goal', allowFinished: true,
    operationId: 'undo-once', operationRequestHash: 'undo-hash' };
  const undone = await repository.undoLastGoal(input); assertPublic(undone);
  assertAtomic(client, 'goal-changed', 'goalAudit'); assert.equal(client.work().length, 2);
  assert.equal(undone?.audit.action, 'goal_undo_last');
  const replayed = await repository.undoLastGoal(input); assertPublic(replayed); assert.deepEqual(replayed, undone);
  assert.equal(client.work().length, 2);
  const receipt = [...client.items.values()].find(item => item.entityType.S === 'goalCorrectionOperation')!;
  assert.deepEqual(body(receipt).result.deletedGoal.timingProvenance, { version: 1, kind: 'post_completion' });
});

test('both finished roster assignment entry points enqueue once; exact assignment replay stays quiet', async () => {
  for (const direct of [false, true]) {
    const { repository, client } = harness();
    if (direct) {
      await repository.assignRosterPlayer({ gameId: 'game', playerId: 'late', teamId: 'red', allowFinished: true });
      await repository.assignRosterPlayer({ gameId: 'game', playerId: 'late', teamId: 'red', allowFinished: true });
    } else {
      await repository.addExistingLeaguePlayer({ gameId: 'game', playerId: 'late', teamId: 'red', userIds: ['admin'], allowFinished: true });
      await repository.addExistingLeaguePlayer({ gameId: 'game', playerId: 'late', teamId: 'red', userIds: ['admin'], allowFinished: true });
    }
    assertAtomic(client, 'roster-changed', 'roster'); assert.equal(client.work().length, 1);
  }
});

test('completed kickoff correction advances source atomically, while unchanged kickoff does not', async () => {
  const { repository, client } = harness();
  await repository.updateGame({ gameId: 'game', gameStartTs: '2026-10-03T09:59:00.000Z' });
  assertAtomic(client, 'kickoff-changed', 'game'); assert.equal(client.work().length, 1);
  await repository.updateGame({ gameId: 'game', gameStartTs: '2026-10-03T09:59:00.000Z' });
  assert.equal(client.work().length, 1);
});

test('initial game, scoped/legacy season and league deletion transactions carry durable obligations', async () => {
  const game = harness('scheduled'); await game.repository.deleteGame('game'); assertAtomic(game.client, 'game-deleted', 'delete');
  assert.equal(await game.repository.deleteGame('game'), false); assert.equal(game.client.work().length, 1);
  for (const scoped of [false, true]) {
    const f = harness('finished', false), season = { leagueId: 'league', seasonId: 'winter', name: 'Winter', slug: null, startsOn: null, endsOn: null, createdByUserId: 'admin' };
    f.client.seed('LEAGUE#league', 'SEASON#winter', 'season', season); f.client.seed('SEASON#winter', 'METADATA', 'season', season);
    await f.repository.deleteSeason('winter', scoped ? { leagueId: 'league' } : {}); assertAtomic(f.client, 'season-deleted', 'delete');
  }
  const league = harness('finished', false); await league.repository.deleteLeague('league'); assertAtomic(league.client, 'league-deleted', 'delete');
  await league.repository.deleteLeague('league'); assert.equal(league.client.work().length, 1);
});

test('failure of a finished goal transaction publishes neither the goal nor source/work rows', async () => {
  const { repository, client } = harness(); client.failHistory = true;
  const before = structuredClone([...client.items.entries()]);
  await assert.rejects(repository.createGoal(goalInput), /changed/);
  assertAtomic(client, 'goal-changed', 'goal'); assert.deepEqual([...client.items.entries()], before);
  assert.equal(client.work().length, 0); assert.equal(client.read('LEAGUE#league', 'HISTORY_SOURCE'), undefined);
});

test('completion and late assignment cannot commit when their history obligation fails', async () => {
  const finishing = harness('live');
  const game = finishing.client.read('GAME#game', 'METADATA')!, value = body(game);
  value.thirds[2].finishedAt = '2026-10-03T11:00:00.000Z'; game.data = { S: JSON.stringify(value) };
  for (const scenario of [
    { fixture: finishing, mutation: () => finishing.repository.finishGame({ gameId: 'game' }) },
    ...[false, true].map(direct => {
      const fixture = harness();
      return { fixture, mutation: () => direct
        ? fixture.repository.assignRosterPlayer({ gameId: 'game', playerId: 'late', teamId: 'red', allowFinished: true })
        : fixture.repository.addExistingLeaguePlayer({ gameId: 'game', playerId: 'late', teamId: 'red', userIds: ['admin'], allowFinished: true }) };
    }),
  ]) {
    scenario.fixture.client.failHistory = true;
    const before = structuredClone([...scenario.fixture.client.items.entries()]);
    await assert.rejects(scenario.mutation());
    assert.deepEqual([...scenario.fixture.client.items.entries()], before);
  }
});

test('finished team overrides publish repair obligations for missing teams, legacy result and raw totals', async () => {
  for (const repair of ['missing-team', 'finished-at', 'missing-result', 'raw-score', 'third-length', 'duplicate-third'] as const) {
    const { repository, client } = harness();
    const game = client.read('GAME#game', 'METADATA')!, value = body(game);
    if (repair === 'missing-team') client.items.delete(JSON.stringify(['GAME#game', 'TEAM#yellow']));
    if (repair === 'finished-at') value.finishedAt = null;
    if (repair === 'missing-result') value.result = null;
    if (repair === 'third-length') delete value.thirdLengthMinutes;
    if (repair === 'duplicate-third') value.thirds.push({ ...value.thirds[0] });
    if (repair === 'raw-score') {
      const team = client.read('GAME#game', 'TEAM#red')!, raw = body(team);
      raw.scored = '0'; delete raw.conceded; team.data = { S: JSON.stringify(raw) };
    }
    game.data = { S: JSON.stringify(value) };
    await repository.createGameTeamOverride({ gameId: 'game', teamId: 'yellow', name: 'Gold', color: '#ffd700',
      createOnly: repair === 'missing-team', allowFinished: true });
    assertAtomic(client, 'game-finished', 'game'); assert.equal(client.work().length, 1, repair);
    const persisted = body(client.read('GAME#game', 'METADATA')!);
    assert(persisted.finishedAt); assert.equal(persisted.result.teams.length, 3);
    const red = body(client.read('GAME#game', 'TEAM#red')!); assert.equal(red.scored, 0); assert.equal(red.conceded, 0);
    await repository.createGameTeamOverride({ gameId: 'game', teamId: 'yellow', name: 'Gold again', allowFinished: true });
    assert.equal(client.work().length, 1, 'subsequent cosmetic override must stay quiet');
  }
});

test('unchanged goal credit still publishes obligations when it repairs completed aggregates or results', async () => {
  for (const repair of ['finished-at', 'third-length', 'duplicate-third', 'missing-result', 'partial-result', 'invalid-result', 'invalid-comparator', 'invalid-outcome',
    'stale-winner', 'stale-score', 'raw-score'] as const) {
    const { repository, client } = harness(); await repository.createGoal(goalInput);
    const game = client.read('GAME#game', 'METADATA')!, value = body(game);
    if (repair === 'finished-at') value.finishedAt = null;
    if (repair === 'third-length') delete value.thirdLengthMinutes;
    if (repair === 'duplicate-third') value.thirds.push({ ...value.thirds[0] });
    if (repair === 'missing-result') value.result = null;
    if (repair === 'partial-result') value.result.teams.pop();
    if (repair === 'invalid-result') value.result.computedAt = 'not-a-date';
    if (repair === 'invalid-comparator') value.result.comparator = 'most_scored';
    if (repair === 'invalid-outcome') value.result.outcome = 'draw';
    if (repair === 'stale-winner') { value.result.winnerTeamId = 'blue'; value.result.outcome = 'win'; }
    if (repair === 'stale-score' || repair === 'raw-score') {
      const team = client.read('GAME#game', 'TEAM#red')!, raw = body(team);
      raw.scored = repair === 'stale-score' ? 9 : '1'; team.data = { S: JSON.stringify(raw) };
    }
    game.data = { S: JSON.stringify(value) };
    const input = { gameId: 'game', eventId: 'goal', actorUserId: 'admin', allowFinished: true };
    assertPublic(await repository.updateGoal(input)); assertAtomic(client, 'goal-changed', 'game');
    assert.equal(client.work().length, 2, repair);
    const persisted = body(client.read('GAME#game', 'METADATA')!);
    assert.equal(persisted.result.winnerTeamId, 'red'); assert.equal(persisted.result.outcome, 'win');
    assert.equal(body(client.read('GAME#game', 'TEAM#red')!).scored, 1);
    await repository.updateGoal(input); assert.equal(client.work().length, 2, 'actual no-op must stay quiet');
  }
});

test('cosmetic team edits and result presentation or calculation-time changes do not enqueue history', async () => {
  const { repository, client } = harness();
  const game = client.read('GAME#game', 'METADATA')!, value = body(game);
  value.result.computedAt = '2026-10-03T11:01:00.000Z'; value.result.teams.reverse();
  value.result.teams[0].name = 'Old presentation'; value.result.teams[0].color = '#123456';
  game.data = { S: JSON.stringify(value) };
  await repository.createGameTeamOverride({ gameId: 'game', teamId: 'red', name: 'Scarlet', color: '#ff0000', allowFinished: true });
  assert.equal(client.work().length, 0);
  await repository.createGoal(goalInput);
  const storedGame = client.read('GAME#game', 'METADATA')!, afterGoal = body(storedGame);
  afterGoal.result.computedAt = '2026-10-03T11:01:00.000Z'; afterGoal.result.teams.reverse();
  afterGoal.result.teams[0].name = 'Old presentation'; storedGame.data = { S: JSON.stringify(afterGoal) };
  await repository.updateGoal({ gameId: 'game', eventId: 'goal', actorUserId: 'admin', allowFinished: true });
  assert.equal(client.work().length, 1);
});

test('unchanged kickoff metadata repairs publish work without invalidating identity coverage', async () => {
  for (const repair of ['third-length', 'duplicate-third', 'result-comparator'] as const) {
    const { repository, client } = harness();
    const game = client.read('GAME#game', 'METADATA')!, value = body(game);
    if (repair === 'third-length') delete value.thirdLengthMinutes;
    if (repair === 'duplicate-third') value.thirds.push({ ...value.thirds[0] });
    if (repair === 'result-comparator') value.result.comparator = 'invalid';
    game.data = { S: JSON.stringify(value) };
    const control = structuredClone(client.read('PLAYER_IDENTITY', 'CONTROL'));
    await repository.updateGame({ gameId: 'game', gameStartTs: value.gameStartTs });
    assertAtomic(client, 'game-finished', 'game'); assert.equal(client.work().length, 1, repair);
    assert.deepEqual(client.read('PLAYER_IDENTITY', 'CONTROL'), control);
    await repository.updateGame({ gameId: 'game', gameStartTs: value.gameStartTs });
    assert.equal(client.work().length, 1);
  }
});

test('join-code repair publishes work only when it also normalizes material finished metadata', async () => {
  for (const repair of [false, true]) {
    const { repository, client } = harness();
    client.items.delete(JSON.stringify(['JOIN_CODE#ABCDEFGH', 'METADATA']));
    const game = client.read('GAME#game', 'METADATA')!, value = body(game);
    if (repair) value.thirds.push({ ...value.thirds[0] });
    game.data = { S: JSON.stringify(value) };
    await repository.getGame('game', { repairLegacyJoinCode: true });
    assert(client.read('JOIN_CODE#ABCDEFGH', 'METADATA'));
    assert.equal(client.work().length, repair ? 1 : 0);
    if (repair) assertAtomic(client, 'game-finished', 'game');
    await repository.getGame('game', { repairLegacyJoinCode: true }); assert.equal(client.work().length, repair ? 1 : 0);
  }
});

test('normalizing raw goal timing publishes work even when credited players and totals remain unchanged', async () => {
  for (const field of ['third', 'elapsedSeconds', 'gameMinute', 'thirdMinute'] as const) {
    const { repository, client } = harness(); await repository.createGoal(goalInput);
    const stored = [...client.items.values()].find(item => item.entityType.S === 'goal')!, goal = body(stored);
    // Valid first-third goal and original creation audit; removing one timing field
    // makes historical proof uncertain until the correction normalizes that field.
    Object.assign(goal, { third: 1, elapsedSeconds: 60, gameMinute: 2, thirdMinute: 2,
      timingProvenance: { version: 1, kind: 'live' } });
    stored.createdAt = { S: '2026-10-03T10:01:00.000Z' };
    const audit = [...client.items.values()].find(item => item.entityType.S === 'goalAudit')!, auditValue = body(audit);
    auditValue.after = { ...auditValue.after, ...goal }; audit.data = { S: JSON.stringify(auditValue) };
    audit.createdAt = { S: '2026-10-03T10:01:00.000Z' };
    delete goal[field]; stored.data = { S: JSON.stringify(goal) };
    const input = { gameId: 'game', eventId: 'goal', actorUserId: 'admin', allowFinished: true };
    assertPublic(await repository.updateGoal(input)); assertAtomic(client, 'goal-changed', 'goal');
    assert.equal(client.work().length, 2, field);
    assert.equal(body(client.read('GAME#game', 'TEAM#red')!).scored, 1);
    await repository.updateGoal(input); assert.equal(client.work().length, 2);
  }
});


test('finished source writes retry transient league revision contention without duplicate work', async () => {
  const { repository, client } = harness();
  client.conflictHistory = 2;
  assertPublic(await repository.createGoal(goalInput));
  const attempts = client.transactions.filter(actions => actions.some(action => action.Put?.Item?.entityType?.S === 'playerHistoryWork'));
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts[0], attempts[1]); assert.deepEqual(attempts[1], attempts[2]);
  assert.equal(client.work().length, 1);
  assert.equal((await repository.listGoalEvents('game')).length, 1);
  assertAtomic(client, 'goal-changed', 'goal');
});

test('new season creation atomically requests default-season reconciliation while exact retries stay quiet', async () => {
  const { repository, client } = harness();
  const input = { leagueId: 'league', seasonId: 'new-season', name: 'New season', startsOn: '2027-01-01' };
  const created = await repository.createSeason(input);
  assertAtomic(client, 'history-rebuild', 'season');
  assert.equal(client.work().length, 1);
  const revision = body(client.items.get(key({ pk: { S: 'LEAGUE#league' }, sk: { S: 'HISTORY_SOURCE' } }))!).revision;
  assert.deepEqual(await repository.createSeason(input), created);
  assert.equal(client.work().length, 1);
  assert.equal(body(client.items.get(key({ pk: { S: 'LEAGUE#league' }, sk: { S: 'HISTORY_SOURCE' } }))!).revision, revision);
  await assert.rejects(repository.createSeason({ ...input, name: 'Changed' }), /season list changed/);
  assert.equal(client.work().length, 1);
});

test('season metadata cannot commit if its history obligation transaction fails', async () => {
  const { repository, client } = harness(); client.failHistory = true;
  await assert.rejects(repository.createSeason({ leagueId: 'league', seasonId: 'blocked', name: 'Blocked' }));
  assert.equal(client.items.has(key({ pk: { S: 'LEAGUE#league' }, sk: { S: 'SEASON#blocked' } })), false);
  assert.equal(client.items.has(key({ pk: { S: 'SEASON#blocked' }, sk: { S: 'METADATA' } })), false);
  assert.equal(client.work().length, 0);
  client.failHistory = false;
  await repository.createSeason({ leagueId: 'league', seasonId: 'blocked', name: 'Blocked' });
  assertAtomic(client, 'history-rebuild', 'season'); assert.equal(client.work().length, 1);
});
