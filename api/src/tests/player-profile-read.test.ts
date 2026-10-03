import assert from 'node:assert/strict';
import test from 'node:test';
import { BatchGetItemCommand, GetItemCommand, QueryCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { ACHIEVEMENT_RULE_VERSION, type AchievementUnlock, type PlayerAppearance } from '@3fc/contracts';
import { emptyAccumulator } from '../achievements/evaluate.js';
import { PlayerProfileReadService, type ProfileAccessReader } from '../data/player-profile-read.js';
import { historyHash, historyKey, historyPartition, historyRow, type HistoryItem } from '../data/player-history-model.js';
import { PlayerIdentityError, identityCondition } from '../data/player-identity.js';
const at = '2026-10-03T01:00:00.000Z', pk = historyPartition('league', 'canonical'), prefix = `GEN#${historyHash('generation')}#`;
const input = { leagueId: 'league', playerId: 'alias', userId: 'account', userIds: ['account', 'private@example.test'], viewerPlayerId: 'viewer' };
const career = { scope: 'career' as const, seasonId: null }, winter = { scope: 'season' as const, seasonId: 'winter' };
class Memory {
  items = new Map<string, HistoryItem>(); reads: Array<{ pk: string; sk: string }> = []; queries: QueryCommand['input'][] = []; batches: number[] = [];
  seed(pk: string, sk: string, type: string, data: unknown) { const item = historyRow(pk, sk, type, data); this.items.set(JSON.stringify([pk, sk]), item); return item; }
  read(pk: string, sk: string) { return this.items.get(JSON.stringify([pk, sk])); }
  remove(pk: string, sk: string) { this.items.delete(JSON.stringify([pk, sk])); }
  async send(command: unknown): Promise<unknown> {
    if (command instanceof GetItemCommand) {
      assert.equal(command.input.ConsistentRead, true); const key = command.input.Key!;
      this.reads.push({ pk: key.pk.S!, sk: key.sk.S! }); return { Item: structuredClone(this.read(key.pk.S!, key.sk.S!)) };
    }
    if (command instanceof BatchGetItemCommand) {
      const request = command.input.RequestItems!.table; assert.equal(request.ConsistentRead, true); this.batches.push(request.Keys!.length);
      return { Responses: { table: request.Keys!.flatMap(key => { const item = this.read(key.pk.S!, key.sk.S!); return item ? [structuredClone(item)] : []; }) } };
    }
    if (command instanceof QueryCommand) {
      const value = command.input; this.queries.push(value); assert.equal(value.ConsistentRead, true);
      const partition = value.ExpressionAttributeValues![':pk'].S!, starts = value.ExpressionAttributeValues![':prefix'].S!;
      const rows = [...this.items.values()].filter(row => row.pk.S === partition && row.sk.S!.startsWith(starts))
        .sort((a, b) => a.sk.S! < b.sk.S! ? -1 : 1);
      if (value.ScanIndexForward === false) rows.reverse();
      const offset = value.ExclusiveStartKey ? rows.findIndex(row => row.sk.S === value.ExclusiveStartKey!.sk.S) + 1 : 0;
      const items = rows.slice(offset, offset + value.Limit!);
      return { Items: structuredClone(items), ...(offset + items.length < rows.length ? { LastEvaluatedKey: historyKey(partition, items.at(-1)!.sk.S!) } : {}) };
    }
    throw new Error('Unexpected command: no scans or writes are permitted');
  }
}
function fixture() {
  const client = new Memory(); let beforeFence: (() => void) | null = null; const fences: TransactWriteItem[][] = [];
  const access: ProfileAccessReader = {
    async authorize(value) { for (const [key, expected] of Object.entries(input)) assert.deepEqual((value as any)[key], expected); return { player: { playerId: 'canonical', displayName: 'Xavier', hasPortrait: false, email: 'private@example.test' },
      league: { leagueId: 'league', name: 'Winter league', createdByUserId: 'private@example.test' }, owner: true, checks: [] } as any; },
    async assertCurrent(_checks, projection = []) {
      beforeFence?.(); beforeFence = null; fences.push(projection);
      for (const action of projection) {
        const check = action.ConditionCheck!; assert(check); const row = client.read(check.Key!.pk.S!, check.Key!.sk.S!);
        const expected = check.ExpressionAttributeValues?.[':data']?.S;
        if (expected === undefined ? Boolean(row) : row?.data.S !== expected)
          throw new PlayerIdentityError('player_profile_changed', 409, 'Changed');
      }
    }
  };
  const latest: PlayerAppearance = { gameId: 'game25', seasonId: 'winter', kickoffAt: at, finishedAt: at, teamId: 'red', outcome: 'win', goals: 5, assists: 1, ownGoals: 0, scored: 6, conceded: 0 };
  const publication = { generation: 'generation', leagueId: 'league', playerId: 'canonical', sourceRevision: 'source1', readinessRevision: '11111111-1111-4111-8111-111111111111',
    ruleVersion: ACHIEVEMENT_RULE_VERSION, identityWriteVersion: 'identity1', identityEpoch: 'epoch', calculatedAt: at, latest, seasons: [{ seasonId: 'winter', lastPlayedAt: at }], previousGeneration: null };
  client.seed('LEAGUE#league', 'HISTORY_SOURCE', 'playerHistorySource', { version: 1, leagueId: 'league', revision: 'source1' });
  client.seed('PLAYER_HISTORY', 'CONTROL', 'playerHistoryReadiness', { version: 1, enabled: true, revision: publication.readinessRevision, ruleVersion: ACHIEVEMENT_RULE_VERSION, activatedAt: at,
    manifest: { version: 1, writerVersion: 1, writerSha: 'a'.repeat(40), tableName: 'table', accountId: '301691475109', region: 'ap-southeast-2', reviewedPlan: 'https://github.com/ajfisher/3fc/pull/209', drainedAt: at, ruleVersion: ACHIEVEMENT_RULE_VERSION } });
  client.seed(pk, 'PUBLISHED', 'playerHistoryPublication', publication);
  client.seed('LEAGUE#league', 'SEASON#winter', 'season', { leagueId: 'league', seasonId: 'winter', name: 'Winter', email: 'private@example.test' });
  client.seed('LEAGUE#league', 'PROFILE_SEASON_DEFAULT', 'playerProfileSeasonDefault', { version: 1, leagueId: 'league', sourceRevision: 'source1', readinessRevision: publication.readinessRevision,
    computedAt: at, season: { seasonId: 'winter', name: 'Winter', startsOn: '2026-05-01', createdAt: at } });
  const states = { career: emptyAccumulator(), winter: emptyAccumulator() };
  for (const [name, scope] of [['career', career], ['winter', winter]] as const) {
    const state = states[name]; state.context = { ...scope, playerId: 'canonical', leagueId: 'league', ruleVersion: ACHIEVEMENT_RULE_VERSION };
    state.totals = { played: 2, goals: 10, assists: 2, ownGoals: 0, wins: 2, draws: 0, losses: 0, goalsPerGame: 5 };
    state.counts.goal = 10; state.counts.played = 2; state.latest = latest;
    const award = { ...scope, id: `${name}-goal3`, achievementId: 'goal' as const, ordinal: 3, threshold: 10, earnedAt: at, gameId: latest.gameId,
      ruleVersion: ACHIEVEMENT_RULE_VERSION, sourceRevision: 'source1' };
    state.highest.goal = award; state.first = { goal: { ...award, id: `${name}-goal1`, ordinal: 1, threshold: 1, gameId: 'game1' } };
    client.seed(pk, `${prefix}STATE#${name}`, 'playerHistorySummary', { state, secret: 'private@example.test' });
  }
  client.seed(pk, `${prefix}META`, 'playerHistoryGeneration', { phase: 'published', spec: { generation: 'generation', context: { leagueId: 'league', playerId: 'canonical', privateField: 'private@example.test' } },
    summaryKeys: { CAREER: `${prefix}STATE#career`, [`SEASON#${historyHash('winter')}`]: `${prefix}STATE#winter` } });
  for (let i = 1; i <= 25; i++) client.seed(pk, `${prefix}MATCH#${String(i).padStart(3, '0')}`, 'playerHistoryAppearance', { ...latest, gameId: `game${i}`, privateField: 'private@example.test' });
  for (let i = 1; i <= 25; i++) client.seed(pk, `${prefix}AWARD#CAREER#${String(i).padStart(3, '0')}`, 'playerHistoryAward', {
    ...career, id: `award${i}`, achievementId: 'own-goal', ordinal: i, threshold: i, earnedAt: at, gameId: `game${i}`, calculatedAt: at, sourceRevision: 'private-source', account: 'private@example.test' });
  const service = new PlayerProfileReadService(client, 'table', access, { profiles: true, achievements: true, ownerEditing: false });
  return { client, service, access, fences, states, publication, latest, changeBeforeFence: (fn: () => void) => { beforeFence = fn; } };
}

test('safe performance combines canonical identity and authoritative totals without internal/private fields', async () => {
  const { service, client, fences } = fixture(); const value = await service.performance(input);
  assert.equal(value.player.playerId, 'canonical'); assert.equal(value.selectedSeasonId, 'winter'); assert.equal(value.career?.goals, 10);
  assert.deepEqual(value.season, value.career); assert.equal(value.latest?.goals, 5); assert.equal(value.capabilities.editProfile, false);
  assert.equal(value.freshness.status, 'ready'); assert.equal(JSON.stringify(value).includes('private'), false);
  assert.deepEqual(client.batches, [1]); assert.equal(client.queries.length, 0);
  assert.deepEqual(fences.at(-1)!.map(value => value.ConditionCheck!.Key!.sk.S).sort(), ['CONTROL', 'HISTORY_SOURCE', 'PROFILE_SEASON_DEFAULT', 'PUBLISHED']);
});

test('supplied seasons win over latest and unknown/cross-league seasons never manufacture zero totals', async () => {
  const { client, service } = fixture();
  client.seed('LEAGUE#league', 'SEASON#summer', 'season', { leagueId: 'league', seasonId: 'summer', name: 'Summer' });
  const value = await service.performance({ ...input, seasonId: 'summer' });
  assert.equal(value.selectedSeasonId, 'summer'); assert.equal(value.season?.played, 0); assert.equal(value.latest?.seasonId, 'winter');
  await assert.rejects(service.performance({ ...input, seasonId: 'missing' }), /season/);
  client.seed('LEAGUE#league', 'SEASON#summer', 'season', { leagueId: 'other', seasonId: 'summer', name: 'Other' });
  await assert.rejects(service.performance({ ...input, seasonId: 'summer' }));
});

test('zero appearances use verified fallback; missing/stale fallback never becomes a confirmed no-season state', async () => {
  for (const missing of [false, true]) {
    const { client, service, publication } = fixture();
    client.seed(pk, 'PUBLISHED', 'playerHistoryPublication', { ...publication, latest: null, seasons: [] });
    client.seed(pk, `${prefix}STATE#career`, 'playerHistorySummary', { state: emptyAccumulator() });
    client.seed(pk, `${prefix}META`, 'playerHistoryGeneration', { phase: 'published', spec: { generation: 'generation', context: { leagueId: 'league', playerId: 'canonical' } }, summaryKeys: { CAREER: `${prefix}STATE#career` } });
    if (missing) client.remove('LEAGUE#league', 'PROFILE_SEASON_DEFAULT');
    const value = await service.performance(input);
    assert.equal(value.freshness.status, missing ? 'updating' : 'ready'); assert.equal(value.career?.played ?? null, missing ? null : 0);
    assert.equal(value.selectedSeasonId, missing ? null : 'winter');
  }
});

test('stale or disabled history returns null data, never old totals, zero progress or false empty logs', async () => {
  for (const disabled of [false, true]) {
    const { client, service } = fixture();
    if (disabled) client.seed('PLAYER_HISTORY', 'CONTROL', 'playerHistoryReadiness', { version: 1, enabled: false });
    else client.seed('LEAGUE#league', 'HISTORY_SOURCE', 'playerHistorySource', { version: 1, leagueId: 'league', revision: 'new' });
    const performance = await service.performance(input), history = await service.history(input), achievements = await service.achievements({ ...input, scope: career });
    assert.equal(performance.career, null); assert.equal(performance.season, null); assert.equal(performance.latest, null);
    assert.equal(history.matches, null); assert.equal(achievements.progress, null); assert.equal(achievements.firstUnlocks, null);
    assert.equal(performance.freshness.status, disabled ? 'unavailable' : 'updating');
    await assert.rejects(service.history({ ...input, cursor: 'old' }), /changed/);
  }
});

test('a source or publication change at final authority fence rejects the assembled response', async () => {
  for (const target of ['source', 'publication']) {
    const { service, client, publication, changeBeforeFence } = fixture();
    changeBeforeFence(() => target === 'source'
      ? client.seed('LEAGUE#league', 'HISTORY_SOURCE', 'playerHistorySource', { version: 1, leagueId: 'league', revision: 'new' })
      : client.seed(pk, 'PUBLISHED', 'playerHistoryPublication', { ...publication, calculatedAt: '2026-10-04T01:00:00.000Z' }));
    await assert.rejects(service.performance(input), (error: any) => error.code === 'player_profile_changed');
  }
});

test('match and unlock pages are newest-first, capped at twenty and bind cursors to generation/type/scope', async () => {
  const { service, client, publication } = fixture();
  const first = await service.history(input); assert.equal(first.matches?.length, 20); assert.equal(first.matches?.[0].gameId, 'game25'); assert(first.cursor);
  const second = await service.history({ ...input, cursor: first.cursor }); assert.equal(second.matches?.length, 5); assert.equal(second.cursor, null);
  const awards = await service.unlocks({ ...input, scope: career }); assert.equal(awards.unlocks?.length, 20); assert(awards.cursor);
  assert.equal(JSON.stringify([first, awards]).includes('private'), false);
  await assert.rejects(service.unlocks({ ...input, scope: career, cursor: first.cursor }), /continuation/);
  assert(client.queries.every(query => query.Limit === 20 && query.ScanIndexForward === false));
  client.seed(pk, 'PUBLISHED', 'playerHistoryPublication', { ...publication, generation: 'new' });
  await assert.rejects(service.history({ ...input, cursor: first.cursor }));
});

test('achievement reads retain first unlocks, partial assessability and latest-game milestones from both scopes', async () => {
  const { service, client, states } = fixture(); states.career.uncertain = ['clutch'];
  client.seed(pk, `${prefix}STATE#career`, 'playerHistorySummary', { state: states.career });
  const value = await service.achievements({ ...input, scope: career });
  assert.equal(value.progress?.length, 23); assert.equal(value.progress?.find(value => value.achievementId === 'clutch')?.assessability, 'partial');
  assert.equal(value.firstUnlocks?.[0].ordinal, 1); assert.equal(value.honours?.[0].ordinal, 3);
  assert.deepEqual(value.latestUnlocks?.map(value => value.scope).sort(), ['career', 'season']);
  assert.equal(JSON.stringify(value).includes('sourceRevision'), false);
  delete states.career.first; client.seed(pk, `${prefix}STATE#career`, 'playerHistorySummary', { state: states.career });
  assert.equal((await service.achievements({ ...input, scope: career })).firstUnlocks, null);
});

test('wrong-scope summary evidence is unavailable instead of leaking another scope award', async () => {
  const { service, client, states } = fixture(); states.career.highest.goal = { ...states.career.highest.goal!, ...winter };
  client.seed(pk, `${prefix}STATE#career`, 'playerHistorySummary', { state: states.career });
  await assert.rejects(service.achievements({ ...input, scope: career }), /unavailable/);
});

test('missing career or played-season pointers cannot turn incomplete published history into ready zeros', async () => {
  for (const scopeKey of ['CAREER', `SEASON#${historyHash('winter')}`]) {
    const { client, service } = fixture();
    const metadata = client.read(pk, `${prefix}META`)!, value = JSON.parse(metadata.data.S!);
    delete value.summaryKeys[scopeKey]; metadata.data = { S: JSON.stringify(value) };
    await assert.rejects(service.performance(input), /summary coverage is incomplete/);
    await assert.rejects(service.achievements({ ...input, scope: scopeKey === 'CAREER' ? career : winter }), /summary coverage is incomplete/);
  }
});

test('a stored empty career accumulator contradicting published appearances is unavailable', async () => {
  for (const preserveContext of [false, true]) {
    const { client, service, states } = fixture();
    const empty = emptyAccumulator(); if (preserveContext) empty.context = states.career.context;
    client.seed(pk, `${prefix}STATE#career`, 'playerHistorySummary', { state: empty });
    await assert.rejects(service.performance(input), /unavailable/);
    await assert.rejects(service.achievements({ ...input, scope: career }), /unavailable/);
  }
});

test('inconsistent outcome and rate totals cannot be presented as ready statistics', async () => {
  for (const totals of [{ wins: 0 }, { goalsPerGame: 99 }]) {
    const { client, service, states } = fixture();
    states.career.totals = { ...states.career.totals, ...totals };
    client.seed(pk, `${prefix}STATE#career`, 'playerHistorySummary', { state: states.career });
    await assert.rejects(service.performance(input), /unavailable/);
  }
});

test('a page row with the wrong season or achievement scope is unavailable', async () => {
  const { client, service, latest } = fixture();
  const award = client.read(pk, `${prefix}AWARD#CAREER#025`)!, data = JSON.parse(award.data.S!);
  award.data = { S: JSON.stringify({ ...data, ...winter }) };
  await assert.rejects(service.unlocks({ ...input, scope: career }), /unavailable/);
  client.seed(pk, `${prefix}SEASON#${historyHash('winter')}#MATCH#001`, 'playerHistoryAppearance', { ...latest, seasonId: 'other' });
  await assert.rejects(service.history({ ...input, seasonId: 'winter' }), /unavailable/);
});
