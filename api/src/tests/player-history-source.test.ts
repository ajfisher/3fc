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
const readiness = { version: 1, enabled: true, revision: '11111111-1111-4111-8111-111111111111', ruleVersion: 1,
  activatedAt: '2026-01-01T00:00:00.000Z', manifest: { version: 1, writerVersion: 1, writerSha: 'a'.repeat(40),
    tableName: 'table', accountId: '123456789012', region: 'ap-southeast-2', reviewedPlan: 'https://github.com/ajfisher/3fc/pull/207',
    drainedAt: '2026-01-01T00:00:00.000Z', ruleVersion: 1 } };
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
  add(row('PLAYER_HISTORY', 'CONTROL', 'playerHistoryReadiness', readiness));
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
  assert.equal(captured.checks.length, 7); assert.equal(captured.sourceRevision, 'r1');
  add(row('PLAYER_IDENTITY', 'CONTROL', 'playerIdentityControl', { mode: 'fenced', epoch: 'e2', coverage: 'unknown', writerVersion: 1 }));
  assert.equal((await source.captureContext('league', 'alias')).identityEpoch, 'e2', 'deletion invalidates merge coverage, not retained history associations');
  add(row('PLAYER_HISTORY', 'CONTROL', 'playerHistoryReadiness', { version: 1, enabled: false, revision: 'ready2' }));
  await assert.rejects(source.captureContext('league', 'alias'));
  records.delete('PLAYER_HISTORY/CONTROL'); await assert.rejects(source.captureContext('league', 'alias'), /not been activated/);
  add(row('PLAYER_HISTORY', 'CONTROL', 'playerHistoryReadiness', readiness));
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

test('unknown goal creation time preserves credited statistics and cannot qualify as live', () => {
  for (const createdAt of [undefined, 'legacy-time', '2026-99-99T00:00:00Z']) {
    const input = fixture();
    if (createdAt === undefined) delete input.goals[0].createdAt;
    else input.goals[0].createdAt = { S: createdAt };
    change(input.goals[0], { timingProvenance: { version: 1, kind: 'live' } });
    const facts = assembleMatchFacts(input)!;
    assert.equal(facts.goals[0].createdAt, null); assert.equal(facts.goals[0].timing, 'unknown');
    assert.equal(facts.goals[0].third, null); assert.equal(facts.goals[0].elapsedSeconds, null);
    assert.deepEqual(facts.goals[0].assistPlayerIds, ['blue-root']);
    const state = applyAppearance(emptyAccumulator(), facts, 'root', 'career').state;
    assert.equal(state.totals.goals, 1); assert.equal(state.totals.wins, 1);
    assert.equal(state.counts['message-sent'], 0); assert(state.uncertain.includes('message-sent'));
    change(input.goals[0], { timingProvenance: { version: 1, kind: 'post_completion' } });
    assert.equal(assembleMatchFacts(input)!.goals[0].timing, 'post_completion');
  }
});

test('unusable or duplicate creation audit snapshots remain ambiguous evidence', () => {
  for (const scenario of ['missing-after', 'scalar-after', 'damaged-duplicate']) {
    const input = fixture();
    if (scenario === 'missing-after') {
      const raw = JSON.parse(input.audits[0].data!.S!); delete raw.after;
      input.audits[0].data = { S: JSON.stringify(raw) };
    }
    if (scenario === 'scalar-after') change(input.audits[0], { after: 'legacy-snapshot' });
    if (scenario === 'damaged-duplicate') {
      const duplicate = structuredClone(input.audits[0]);
      change(duplicate, { auditId: 'duplicate' });
      duplicate.sk = { S: goalAuditSk('legacy-time', 'duplicate') };
      duplicate.createdAt = { S: 'legacy-time' };
      input.audits.push(duplicate);
    }
    const facts = assembleMatchFacts(input)!;
    assert.equal(facts.goals[0].timing, 'unknown', scenario);
    assert.equal(applyAppearance(emptyAccumulator(), facts, 'root', 'career').state.totals.goals, 1, scenario);
  }
});

test('legacy completed match without finalisation metadata retains its recorded end and draw honours', () => {
  for (const absent of [false, true]) {
    const input = fixture(), metadata = JSON.parse(input.game.data!.S!);
    metadata.finishedAt = null; metadata.result = null;
    if (absent) { delete metadata.finishedAt; delete metadata.result; }
    input.game.data = { S: JSON.stringify(metadata) };
    input.goals = []; input.audits = [];
    input.teams.forEach(item => change(item, { scored: 0, conceded: 0 }));
    const original = structuredClone(input), facts = assembleMatchFacts(input)!;
    assert.equal(facts.finishedAt, '2026-01-01T11:00:00.000Z');
    const result = applyAppearance(emptyAccumulator(), facts, 'root', 'career');
    assert.equal(result.state.totals.played, 1); assert.equal(result.state.totals.draws, 1);
    assert.equal(result.state.totals.goals, 0);
    assert(result.unlocks.some(award => award.achievementId === 'draw'));
    assert(result.unlocks.every(award => award.earnedAt === facts.finishedAt));
    assert.deepEqual(input, original, 'The adapter must not repair or rewrite source records');
  }
});

test('missing legacy results derive from reconciled goals and totals, including own goals', () => {
  const input = fixture(); change(input.game, { result: null });
  const win = applyAppearance(emptyAccumulator(), assembleMatchFacts(input)!, 'root', 'career').state;
  assert.equal(win.totals.goals, 1); assert.equal(win.totals.wins, 1);
  change(input.goals[0], { ownGoal: true, scoringTeamId: null, concedingTeamId: 'red', assistPlayerIds: [] });
  input.teams.forEach(item => change(item, { scored: 0, conceded: JSON.parse(item.data!.S!).teamId === 'red' ? 1 : 0 }));
  const loss = applyAppearance(emptyAccumulator(), assembleMatchFacts(input)!, 'root', 'career').state;
  assert.equal(loss.totals.goals, 0); assert.equal(loss.totals.ownGoals, 1); assert.equal(loss.totals.losses, 1);
  assert.equal(loss.counts.goal, 0); assert.equal(loss.counts['own-goal'], 1);
});

test('fallback completion requires exactly three unique valid chronological intervals', () => {
  for (const scenario of ['missing', 'duplicate', 'extra', 'malformed', 'reversed', 'overlapping', 'before-kickoff']) {
    const input = fixture(), metadata = JSON.parse(input.game.data!.S!);
    metadata.finishedAt = null; metadata.result = null;
    if (scenario === 'missing') metadata.thirds.pop();
    if (scenario === 'duplicate') metadata.thirds[1].third = 1;
    if (scenario === 'extra') metadata.thirds.push({ ...metadata.thirds[2], third: 4 });
    if (scenario === 'malformed') metadata.thirds[2].finishedAt = 'unknown';
    if (scenario === 'reversed') metadata.thirds[2].finishedAt = '2026-01-01T10:39:59.000Z';
    if (scenario === 'overlapping') metadata.thirds[1].startedAt = '2026-01-01T10:19:00.000Z';
    if (scenario === 'before-kickoff') metadata.gameStartTs = '2026-01-01T12:00:00.000Z';
    input.game.data = { S: JSON.stringify(metadata) };
    assert.throws(() => assembleMatchFacts(input), scenario);
  }
});

test('legacy fallbacks never hide contradictory present metadata or unreconciled totals', () => {
  for (const scenario of ['invalid-finish', 'invalid-result', 'wrong-result', 'missing-team', 'wrong-total']) {
    const input = fixture();
    change(input.game, { finishedAt: null, result: null });
    if (scenario === 'invalid-finish') change(input.game, { finishedAt: 'unknown' });
    if (scenario === 'invalid-result') change(input.game, { result: {} });
    if (scenario === 'wrong-result') change(input.game, { result: { ...JSON.parse(fixture().game.data!.S!).result, winnerTeamId: 'blue' } });
    if (scenario === 'missing-team') input.teams.pop();
    if (scenario === 'wrong-total') change(input.teams[0], { scored: 2 });
    assert.throws(() => assembleMatchFacts(input), scenario);
  }
  const input = fixture(); change(input.game, { result: null, thirds: null });
  const facts = assembleMatchFacts(input)!;
  assert.equal(facts.finishedAt, '2026-01-01T11:05:00.000Z', 'A saved finish takes precedence');
  assert.equal(facts.goals[0].timing, 'unknown');
  assert.equal(applyAppearance(emptyAccumulator(), facts, 'root', 'career').state.totals.wins, 1);
});

test('derived legacy finish preserves timing proof and excludes post-end goals', () => {
  const input = fixture(); change(input.game, { finishedAt: null, result: null });
  assert.equal(assembleMatchFacts(input)!.goals[0].timing, 'live');
  input.audits = [];
  assert.equal(assembleMatchFacts(input)!.goals[0].timing, 'unknown');
  input.goals[0].createdAt = { S: '2026-01-01T11:00:00.001Z' };
  change(input.goals[0], { timingProvenance: { version: 1, kind: 'live' } });
  const facts = assembleMatchFacts(input)!;
  assert.equal(facts.goals[0].timing, 'post_completion');
  const state = applyAppearance(emptyAccumulator(), facts, 'root', 'career').state;
  assert.equal(state.totals.goals, 1); assert.equal(state.counts.clutch, 0);
  const at = '2026-01-01T11:00:00.000Z', equal = fixture();
  change(equal.game, { finishedAt: null, result: null });
  change(equal.goals[0], { third: 3, elapsedSeconds: 1200, gameMinute: 60, thirdMinute: 20 });
  equal.goals[0].sk = { S: goalSk(3, 60, 1200, 'event') }; equal.goals[0].createdAt = { S: at };
  change(equal.audits[0], { after: JSON.parse(equal.goals[0].data!.S!) });
  equal.audits[0].createdAt = { S: at }; equal.audits[0].sk = { S: goalAuditSk(at, 'audit') };
  assert.equal(assembleMatchFacts(equal)!.goals[0].timing, 'unknown');
  change(equal.goals[0], { timingProvenance: { version: 1, kind: 'live' } });
  assert.equal(assembleMatchFacts(equal)!.goals[0].timing, 'live');
});
