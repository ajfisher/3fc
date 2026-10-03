import assert from 'node:assert/strict';
import test from 'node:test';
import { GetItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { HistorySource, assembleMatchFacts } from '../data/player-history-source.js';
import { historyRow, type HistoryContext, type HistoryItem } from '../data/player-history-model.js';
import { identityGameSk, identityTombstoneSk } from '../data/player-identity.js';
import { goalSk, goalAuditSk } from '../data/keys.js';
import { applyAppearance, emptyAccumulator } from '../achievements/evaluate.js';

const context: HistoryContext = { leagueId: 'league', playerId: 'root', members: ['root', 'alias'], displayName: 'Player',
  sourceRevision: 'r1', identityWriteVersion: 'w1', identityEpoch: 'e1', checks: [] };
const row = (pk: string, sk: string, type: string, data: unknown, at = '2026-01-01T10:05:00.000Z'): HistoryItem =>
  ({ ...historyRow(pk, sk, type, data), createdAt: { S: at }, updatedAt: { S: at } });
const reference = (gameId: string, leagueId = 'league') => row('PLAYER#alias', identityGameSk(gameId), 'playerGameMembership',
  { playerId: 'alias', gameId, leagueId, seasonId: 'winter', gameStartTs: '2026-01-01T10:00:00.000Z' });
function fixture() {
  const at = '2026-01-01T10:05:00.000Z';
  const rawGoal = { gameId: 'g', eventId: 'event', third: 1 as const, elapsedSeconds: 300, thirdMinute: 6, gameMinute: 6,
    scorerPlayerId: 'alias', assistPlayerIds: ['blue'], scoringTeamId: 'red', concedingTeamId: 'blue', ownGoal: false };
  const teams = ([['red', 1, 0, 'win'], ['blue', 0, 1, 'loss'], ['yellow', 0, 0, 'loss']] as const)
    .map(([teamId, scored, conceded, outcome]) => ({ teamId, scored, conceded, outcome }));
  const game = row('GAME#g', 'METADATA', 'game', { gameId: 'g', leagueId: 'league', seasonId: 'winter', status: 'finished',
    gameStartTs: '2026-01-01T10:00:00.000Z', finishedAt: '2026-01-01T11:05:00.000Z', thirdLengthMinutes: 20,
    thirds: [1, 2, 3].map(third => ({ third, startedAt: `2026-01-01T10:${String((third - 1) * 20).padStart(2, '0')}:00.000Z`,
      finishedAt: third === 3 ? '2026-01-01T11:00:00.000Z' : `2026-01-01T10:${third * 20}:00.000Z` })),
    result: { winnerTeamId: 'red', outcome: 'win', comparator: 'fewest_conceded_then_most_scored', teams } });
  return { context, game, roster: [row('GAME#g', 'ROSTER#red#alias', 'roster', { gameId: 'g', playerId: 'alias', teamId: 'red' })],
    goals: [row('GAME#g', goalSk(1, 6, 300, 'event'), 'goal', rawGoal, at)],
    audits: [row('GAME#g', goalAuditSk(at, 'audit'), 'goalAudit', { auditId: 'audit', gameId: 'g', eventId: 'event', action: 'goal_created', after: { ...rawGoal } }, at)],
    teams: teams.map(value => row('GAME#g', `TEAM#${value.teamId}`, 'gameTeam', { ...value, gameId: 'g' })),
    canonicalIds: new Map([['alias', 'root'], ['blue', 'blue-root']]) };
}
function change(item: HistoryItem, update: Record<string, unknown>) {
  item.data = { S: JSON.stringify({ ...JSON.parse(item.data!.S!), ...update }) };
}

test('captures canonical alias root and immutable source/control/league publication fences', async () => {
  const records = new Map<string, HistoryItem>();
  const add = (item: HistoryItem) => records.set(`${item.pk!.S}/${item.sk!.S}`, item);
  add(row('PLAYER_IDENTITY', 'CONTROL', 'playerIdentityControl', { mode: 'fenced', epoch: 'e1', coverage: 'verified', writerVersion: 1 }));
  for (const id of ['root', 'alias']) add(row(`PLAYER#${id}`, 'IDENTITY', 'playerIdentity', { playerId: id, rootId: 'root',
    members: id === 'root' ? ['root', 'alias'] : [], identityVersion: 1, writeVersion: 'w1', displayName: 'Player', formerNames: [] }));
  add(row('LEAGUE#league', 'METADATA', 'league', { leagueId: 'league' }));
  add(row('LEAGUE#league', 'HISTORY_SOURCE', 'playerHistorySource', { leagueId: 'league', version: 1, revision: 'r1' }));
  const source = new HistorySource({ async send(command) {
    assert(command instanceof GetItemCommand); assert.equal(command.input.ConsistentRead, true);
    return { Item: records.get(`${command.input.Key!.pk!.S}/${command.input.Key!.sk!.S}`) };
  } }, 'table');
  const captured = await source.captureContext('league', 'alias');
  assert.equal(captured.playerId, 'root'); assert.deepEqual(captured.members, ['root', 'alias']);
  assert.equal(captured.checks.length, 6); assert.equal(captured.sourceRevision, 'r1');
  add(row('PLAYER_IDENTITY_TOMBSTONE', identityTombstoneSk('league', ['league']), 'playerIdentityTombstone', { kind: 'league', ids: ['league'] }));
  await assert.rejects(source.captureContext('league', 'alias'), /no longer available/);
});

test('bounded membership pages preserve continuation across filtered leagues and bind it to the source generation', async () => {
  const refs = [reference('a', 'other'), reference('b', 'other')].sort((a, b) => a.sk!.S!.localeCompare(b.sk!.S!));
  let calls = 0;
  const source = new HistorySource({ async send(command) {
    assert(command instanceof QueryCommand); assert.equal(command.input.ConsistentRead, true); assert.equal(command.input.Limit, 1);
    return calls++ === 0 ? { Items: [refs[0]], LastEvaluatedKey: { pk: refs[0].pk, sk: refs[0].sk } } : { Items: [] };
  } }, 'table');
  const first = await source.memberGamesPage(context, 'alias', undefined, 1);
  assert.deepEqual(first.items, []); assert.ok(first.cursor);
  await assert.rejects(source.memberGamesPage({ ...context, sourceRevision: 'r2' }, 'alias', first.cursor!, 1), /continuation/);
  assert.equal(calls, 1);
  const second = await source.memberGamesPage(context, 'alias', first.cursor!, 1);
  assert.equal(second.cursor, null); assert.equal(calls, 2);
});

test('rejects nonadvancing, wrong-partition and malformed source pages without truncating silently', async () => {
  const ref = reference('g');
  for (const response of [
    { Items: [ref], LastEvaluatedKey: { pk: { S: 'PLAYER#someone' }, sk: ref.sk } },
    { Items: [ref, ref] },
    { Items: [{ ...ref, entityType: { S: 'wrong' } }] }
  ]) {
    const source = new HistorySource({ async send() { return response; } }, 'table');
    await assert.rejects(source.memberGamesPage(context, 'alias', undefined, 1));
  }
  let sends = 0;
  const source = new HistorySource({ async send() { sends++; return {}; } }, 'table');
  await assert.rejects(source.memberGamesPage(context, 'not-member'));
  await assert.rejects(source.gamePartitionPage('g', 'goals', undefined, 101));
  assert.equal(sends, 0);
});

test('complete raw match assembles canonical credit with evidenced historical timing, preserving input', () => {
  const input = fixture(), copy = structuredClone(input);
  const facts = assembleMatchFacts(input)!;
  assert.equal(facts.goals[0].scorerPlayerId, 'root'); assert.deepEqual(facts.goals[0].assistPlayerIds, ['blue-root']);
  assert.equal(facts.goals[0].timing, 'live'); assert.equal(facts.goals[0].elapsedSeconds, 300);
  assert.deepEqual(facts.thirdEndsSeconds, [1200, 1200, 1200]); assert.equal(facts.sourceRevision, 'r1');
  assert.deepEqual(input, copy);
});

test('missing audit, changed raw time and incomplete historical fields remain unknown, never opening-time defaults', () => {
  for (const scenario of ['no-audit', 'bad-audit', 'missing-time']) {
    const input = fixture();
    if (scenario === 'no-audit') input.audits = [];
    if (scenario === 'bad-audit') change(input.audits[0], { after: { ...JSON.parse(input.audits[0].data!.S!).after, elapsedSeconds: 0 } });
    if (scenario === 'missing-time') { const raw = JSON.parse(input.goals[0].data!.S!); delete raw.elapsedSeconds; input.goals[0].data = { S: JSON.stringify(raw) }; }
    const goal = assembleMatchFacts(input)!.goals[0];
    assert.equal(goal.timing, 'unknown'); assert.equal(goal.third, null); assert.equal(goal.elapsedSeconds, null);
  }
});

test('explicit capture proves live timing without audit; additions after completion remain ineligible', () => {
  const explicit = fixture(); explicit.audits = [];
  change(explicit.goals[0], { timingProvenance: { version: 1, kind: 'live' } });
  assert.equal(assembleMatchFacts(explicit)!.goals[0].timing, 'live');
  explicit.goals[0].createdAt = { S: '2026-01-02T10:00:00.000Z' };
  assert.equal(assembleMatchFacts(explicit)!.goals[0].timing, 'post_completion');
  const classified = fixture(); change(classified.goals[0], { timingProvenance: { version: 1, kind: 'post_completion' } });
  assert.equal(assembleMatchFacts(classified)!.goals[0].timing, 'post_completion');
});

test('source mismatch, incomplete totals and canonical collisions fail closed', () => {
  for (const scenario of ['goals-missing', 'teams-missing', 'result-wrong', 'scope-wrong', 'unresolved', 'self-assist']) {
    const input = fixture();
    if (scenario === 'goals-missing') input.goals = [];
    if (scenario === 'teams-missing') input.teams.pop();
    if (scenario === 'result-wrong') change(input.game, { result: { ...JSON.parse(input.game.data!.S!).result, winnerTeamId: 'blue' } });
    if (scenario === 'scope-wrong') change(input.game, { leagueId: 'elsewhere' });
    if (scenario === 'unresolved') input.canonicalIds.delete('alias');
    if (scenario === 'self-assist') input.canonicalIds.set('blue', 'root');
    assert.throws(() => assembleMatchFacts(input), scenario);
  }
});

test('malformed legacy temporal evidence preserves confirmed goals, assists and results without invented timing', () => {
  for (const scenario of ['negative-time', 'string-time', 'invalid-third', 'null-time', 'key-disagreement',
    'no-thirds', 'null-thirds', 'bad-third-start', 'reversed-interval', 'after-completion', 'overlapping-intervals']) {
    const input = fixture();
    if (scenario === 'negative-time') change(input.goals[0], { elapsedSeconds: -1 });
    if (scenario === 'string-time') change(input.goals[0], { elapsedSeconds: '300' });
    if (scenario === 'invalid-third') change(input.goals[0], { third: 9 });
    if (scenario === 'null-time') change(input.goals[0], { elapsedSeconds: null });
    if (scenario === 'key-disagreement') change(input.goals[0], { elapsedSeconds: 301 });
    const metadata = JSON.parse(input.game.data!.S!);
    if (scenario === 'no-thirds') delete metadata.thirds;
    if (scenario === 'null-thirds') metadata.thirds = null;
    if (scenario === 'bad-third-start') metadata.thirds[0].startedAt = 'not-a-date';
    if (scenario === 'reversed-interval') metadata.thirds[0].finishedAt = '2026-01-01T09:59:00.000Z';
    if (scenario === 'after-completion') metadata.thirds[0].finishedAt = '2026-01-02T10:00:00.000Z';
    if (scenario === 'overlapping-intervals') metadata.thirds[1].startedAt = '2026-01-01T10:19:00.000Z';
    input.game.data = { S: JSON.stringify(metadata) };
    const facts = assembleMatchFacts(input)!;
    assert.equal(facts.goals[0].timing, 'unknown', scenario);
    assert.equal(facts.goals[0].third, null, scenario); assert.equal(facts.goals[0].elapsedSeconds, null, scenario);
    assert.deepEqual(facts.goals[0].assistPlayerIds, ['blue-root']);
    const { state } = applyAppearance(emptyAccumulator(), facts, 'root', 'career');
    assert.equal(state.totals.goals, 1, scenario); assert.equal(state.totals.wins, 1, scenario);
    assert.equal(state.counts['message-sent'], 0, scenario); assert.equal(state.counts.clutch, 0, scenario);
  }
});

test('legacy exact-completion timestamps stay unknown despite a matching audit; explicit live provenance resolves equality', () => {
  const input = fixture(), at = '2026-01-01T11:00:00.000Z';
  change(input.game, { finishedAt: at });
  change(input.goals[0], { third: 3, elapsedSeconds: 1200, gameMinute: 60, thirdMinute: 20 });
  input.goals[0].sk = { S: goalSk(3, 60, 1200, 'event') };
  input.goals[0].createdAt = { S: at };
  change(input.audits[0], { after: JSON.parse(input.goals[0].data!.S!) });
  input.audits[0].createdAt = { S: at }; input.audits[0].sk = { S: goalAuditSk(at, 'audit') };
  const legacy = assembleMatchFacts(input)!;
  assert.equal(legacy.goals[0].timing, 'unknown');
  assert.equal(applyAppearance(emptyAccumulator(), legacy, 'root', 'career').state.counts.clutch, 0);
  change(input.goals[0], { timingProvenance: { version: 1, kind: 'live' } });
  const explicit = assembleMatchFacts(input)!;
  assert.equal(explicit.goals[0].timing, 'live');
  assert.equal(applyAppearance(emptyAccumulator(), explicit, 'root', 'career').state.counts.clutch, 1);
});

test('unusable audit timestamp evidence cannot discard valid aggregate statistics', () => {
  for (const scenario of ['missing', 'malformed', 'key-disagreement']) {
    const input = fixture();
    if (scenario === 'missing') delete input.audits[0].createdAt;
    if (scenario === 'malformed') input.audits[0].createdAt = { S: 'legacy-time' };
    if (scenario === 'key-disagreement') input.audits[0].createdAt = { S: '2026-01-01T10:05:01.000Z' };
    const facts = assembleMatchFacts(input)!;
    assert.equal(facts.goals[0].timing, 'unknown', scenario);
    const scorer = applyAppearance(emptyAccumulator(), facts, 'root', 'career').state;
    assert.equal(scorer.totals.goals, 1, scenario); assert.equal(scorer.totals.wins, 1, scenario);
    assert.equal(scorer.counts['message-sent'], 0, scenario); assert.equal(scorer.counts.clutch, 0, scenario);
  }
});
