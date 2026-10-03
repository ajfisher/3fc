import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, stat, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { QA, auditArguments, inventoryPage, privateInventoryStep, auditLeaguePage } from '../qa/player-history-audit.mjs';

const binding = { ...QA, head: 'a'.repeat(40), runId: '123' };
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const directorySk = id => `PLAYER#${hash([id])}`;
const row = (pk, sk, entityType, value) => ({ pk: { S: pk }, sk: { S: sk }, entityType: { S: entityType }, data: { S: JSON.stringify(value) } });
const zero = () => ({ played: 0, goals: 0, assists: 0, ownGoals: 0, wins: 0, draws: 0, losses: 0, goalsPerGame: 0 });
const appearance = (gameId = 'g', seasonId = 's', goals = 1) => ({ gameId, seasonId, kickoffAt: '2026-01-01T12:00:00.000Z',
  finishedAt: '2026-01-01T13:00:00.000Z', teamId: 'red', outcome: 'win', goals, assists: 0, ownGoals: 0, scored: goals, conceded: 0 });
function sum(matches) {
  const value = zero();
  for (const match of matches) { value.played++; value.goals += match.goals; value.assists += match.assists; value.ownGoals += match.ownGoals; value[`${match.outcome === 'loss' ? 'losse' : match.outcome}s`]++; }
  value.goalsPerGame = value.played ? value.goals / value.played : 0;
  return value;
}
function fixture(matches = [appearance()]) {
  const rows = new Map(), commands = [], pk = 'LEAGUE#l', set = item => rows.set(`${item.pk.S}|${item.sk.S}`, item);
  set(row(pk, 'METADATA', 'league', { leagueId: 'l', name: 'Must not be output' }));
  set(row(pk, 'HISTORY_SOURCE', 'playerHistorySource', { version: 1, leagueId: 'l', revision: 'source' }));
  const directory = row(pk, 'PLAYER_DIRECTORY', 'playerDirectoryRevision', { revision: 'directory' }); set(directory);
  set(row(pk, 'HISTORY_SWEEP', 'playerHistorySweep', { version: 1, leagueId: 'l', revision: 'source', readinessRevision: 'ready', directoryData: directory.data.S,
    phase: 'complete', completedAt: '2026-01-01T00:00:00Z', cursor: null, seasonCatalogueVersion: 1, checked: 1, enqueued: 1 }));
  set(row(pk, 'PROFILE_SEASON_DEFAULT', 'playerProfileSeasonDefault', { version: 1, leagueId: 'l', sourceRevision: 'source', readinessRevision: 'ready', season: null }));
  const ready = row('PLAYER_HISTORY', 'CONTROL', 'playerHistoryReadiness', { revision: 'ready' }); set(ready);
  const control = row('PLAYER_IDENTITY', 'CONTROL', 'playerIdentityControl', { epoch: 'epoch' }); set(control);
  set(row(pk, directorySk('p'), 'leaguePlayer', { playerId: 'p', active: true, nickname: 'Private display name' }));
  const publication = { generation: 'generation', leagueId: 'l', playerId: 'p', sourceRevision: 'source', readinessRevision: 'ready', ruleVersion: 1,
    latest: matches[0] ?? null, seasons: [...new Set(matches.map(value => value.seasonId))].map(seasonId => ({ seasonId })) };
  const context = { playerId: 'p', leagueId: 'l', sourceRevision: 'source', readinessRevision: 'ready', members: ['p'], checks: [] };
  let beforeSend;
  const client = { async send(command) {
    commands.push(command);
    if (beforeSend) await beforeSend(command);
    const input = command.input;
    assert.equal(input.TableName ?? input.TransactItems?.[0]?.Get?.TableName, QA.tableName);
    if (command.constructor.name === 'TransactGetItemsCommand') return { Responses: input.TransactItems.map(({ Get }) => ({ Item: structuredClone(rows.get(`${Get.Key.pk.S}|${Get.Key.sk.S}`)) })) };
    if (command.constructor.name === 'GetItemCommand') return { Item: structuredClone(rows.get(`${input.Key.pk.S}|${input.Key.sk.S}`)) };
    if (command.constructor.name === 'QueryCommand') {
      assert.equal(input.Limit, 1); assert.equal(input.ConsistentRead, true);
      const list = [...rows.values()].filter(value => value.pk.S === input.ExpressionAttributeValues[':pk'].S && value.sk.S.startsWith('PLAYER#')
        && (!input.ExclusiveStartKey || value.sk.S > input.ExclusiveStartKey.sk.S)).sort((a, b) => a.sk.S.localeCompare(b.sk.S));
      return { Items: structuredClone(list.slice(0, 1)), ...(list.length > 1 ? { LastEvaluatedKey: { pk: list[0].pk, sk: list[0].sk } } : {}) };
    }
    throw new Error(`Mutating/unexpected command ${command.constructor.name}`);
  } };
  const runtime = {
    identityDirectorySk: directorySk, profileSeasonDefaultSchema: z.object({ version: z.literal(1), leagueId: z.string(), sourceRevision: z.string(), readinessRevision: z.string(), season: z.null() }),
    readiness: async () => ({ item: ready, value: { revision: 'ready' } }), control: async () => ({ item: control, value: { epoch: 'epoch' } }),
    source: { captureContext: async () => structuredClone(context) },
    publicationCurrent: (value, source, readiness) => value?.sourceRevision === source && value.readinessRevision === readiness && value.ruleVersion === 1,
    matchOrderKey: value => `${new Date(value.kickoffAt).toISOString()}#${createHash('sha256').update(value.gameId).digest('hex')}`,
    store: {
      getPublication: async () => structuredClone(publication),
      getSummary: async (_league, _player, scope) => ({ state: { context: matches.length ? { leagueId: 'l', playerId: 'p', ...scope } : null,
        totals: sum(matches.filter(value => scope.scope === 'career' || value.seasonId === scope.seasonId)) } }),
      pageMatches: async input => {
        assert.equal(input.limit, 20);
        const all = matches.filter(value => input.seasonId === undefined || value.seasonId === input.seasonId), start = Number(input.cursor ?? 0);
        return { items: structuredClone(all.slice(start, start + 20)), cursor: start + 20 < all.length ? String(start + 20) : null };
      }
    }
  };
  return { client, runtime, rows, set, publication, context, commands, beforeSend: callback => { beforeSend = callback; } };
}
const step = (fixture, cursor) => auditLeaguePage({ ...fixture, binding, leagueId: 'l', cursor });

test('QA audit arguments require exact explicit scope and reject foreign or malformed cursors', async () => {
  const args = ['audit', '--head', binding.head, '--run-id', binding.runId, '--profile', QA.profile, '--league', 'l'];
  assert.equal(auditArguments(args).leagueId, 'l');
  for (const changed of [['--profile', 'default'], ['--head', 'main'], ['--run-id', '0']]) {
    const next = [...args]; next[next.indexOf(changed[0]) + 1] = changed[1]; assert.throws(() => auditArguments(next));
  }
  assert.throws(() => auditArguments([...args, '--table', 'production']));
  assert.throws(() => auditArguments([...args, '--cursor', 'not-json']));
  assert.throws(() => auditArguments(['inventory', ...args.slice(1, -2)]), /private --state/);
  assert.equal(auditArguments(['inventory', ...args.slice(1, -2), '--state', '/tmp/qa-inventory.json']).stateFile, '/tmp/qa-inventory.json');
  assert.throws(() => auditArguments(['inventory', ...args.slice(1, -2), '--state', '/tmp/state', '--cursor', 'secret']), /private --state/);
  const first = await step(fixture());
  await assert.rejects(auditLeaguePage({ ...fixture(), binding: { ...binding, head: 'b'.repeat(40) }, leagueId: 'l', cursor: first.cursor }), /scope changed/);
  await assert.rejects(auditLeaguePage({ ...fixture(), binding, leagueId: 'other', cursor: first.cursor }));
});

test('inventory stores raw secret continuation only in an owned0600 file and never stdout', async () => {
  const directory = await mkdtemp(join(tmpdir(), '3fc-audit-test-')), stateFile = join(directory, 'state.json');
  try {
    const secret = 'AUTH_SESSION#live-session-token', after = { pk: { S: secret }, sk: { S: 'USER#private@example.test' } };
    const client = { send: async () => ({ Items: [], ScannedCount: 100, LastEvaluatedKey: after }) };
    const output = await privateInventoryStep({ stateFile, binding, run: cursor => inventoryPage({ client, binding, cursor }) });
    assert.equal(output.status, 'partial'); assert.equal(Object.hasOwn(output, 'cursor'), false);
    assert(!JSON.stringify(output).includes(secret)); assert(!JSON.stringify(output).includes('private@example.test'));
    assert.equal((await stat(stateFile)).mode & 0o777, 0o600);
    const state = JSON.parse(await readFile(stateFile, 'utf8'));
    assert(Buffer.from(state.cursor, 'base64url').toString().includes(secret));
    let resumed;
    const final = await privateInventoryStep({ stateFile, binding, run: async cursor => { resumed = cursor; return { status: 'complete', cursor: null, leagueIds: [], scanned: 100, live: 0 }; } });
    assert.equal(resumed, state.cursor); assert.equal(final.status, 'complete');
    const replayed = await privateInventoryStep({ stateFile, binding, run: async () => assert.fail('must not run') });
    assert.equal(replayed.replayed, true); assert.deepEqual(replayed.allLeagueIds, []);
    await chmod(stateFile, 0o644);
    await assert.rejects(privateInventoryStep({ stateFile, binding, run: async () => assert.fail('must not run') }), /0600/);
    const link = join(directory, 'link'); await symlink(stateFile, link);
    await assert.rejects(privateInventoryStep({ stateFile: link, binding, run: async () => assert.fail('must not run') }), /0600/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('failed final provenance check leaves inventory checkpoint untouched', async () => {
  const directory = await mkdtemp(join(tmpdir(), '3fc-audit-test-')), stateFile = join(directory, 'state.json');
  try {
    await assert.rejects(privateInventoryStep({ stateFile, binding, run: async () => ({ status: 'complete', cursor: null, leagueIds: [], live: 0, scanned: 0 }), beforeSave: async () => { throw new Error('changed deployment'); } }), /changed deployment/);
    await assert.rejects(stat(stateFile), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('lost inventory stdout never loses earlier IDs and completed output can be replayed', async () => {
  const directory = await mkdtemp(join(tmpdir(), '3fc-audit-test-')), stateFile = join(directory, 'state.json');
  try {
    // Deliberately discard the first page result, as if the process died after saving.
    await privateInventoryStep({ stateFile, binding, run: async () => ({ status: 'partial', cursor: 'opaque-private-next', leagueIds: ['first'], live: 1, scanned: 100 }) });
    const final = await privateInventoryStep({ stateFile, binding, run: async cursor => {
      assert.equal(cursor, 'opaque-private-next'); return { status: 'complete', cursor: null, leagueIds: ['second'], live: 2, scanned: 101 };
    } });
    assert.deepEqual(final.allLeagueIds, ['first', 'second']); assert.equal(Object.hasOwn(final, 'cursor'), false);
    const replayed = await privateInventoryStep({ stateFile, binding, run: async () => assert.fail('completed replay must not scan') });
    assert.deepEqual(replayed.allLeagueIds, final.allLeagueIds); assert.equal(replayed.live, 2);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('inventory cumulative IDs and private file bytes have hard bounds without truncation', async () => {
  const directory = await mkdtemp(join(tmpdir(), '3fc-audit-test-')), stateFile = join(directory, 'state.json');
  try {
    await assert.rejects(privateInventoryStep({ stateFile, binding, run: async () => ({ status: 'complete', cursor: null,
      leagueIds: Array.from({ length: 10001 }, (_, index) => `league-${index}`), live: 10001, scanned: 10001 }) }));
    await assert.rejects(stat(stateFile), { code: 'ENOENT' });
    await assert.rejects(privateInventoryStep({ stateFile, binding, run: async () => ({ status: 'complete', cursor: null,
      leagueIds: Array.from({ length: 200 }, (_, index) => `${index}-${'x'.repeat(2000)}`), live: 200, scanned: 200 }) }), /storage|state budget/);
    await assert.rejects(stat(stateFile), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('inventory preserves an empty filtered page and strongly proves live and deleted leagues', async () => {
  const commands = [], continuation = { pk: { S: 'ANY#cursor' }, sk: { S: 'ROW' } };
  const client = { async send(command) {
    commands.push(command); const input = command.input;
    if (command.constructor.name === 'ScanCommand') {
      assert.equal(input.Limit, 100); assert.equal(input.ProjectionExpression, 'pk, sk, entityType');
      return input.ExclusiveStartKey ? { Items: ['live', 'deleted'].map(id => ({ pk: { S: `LEAGUE#${id}` }, sk: { S: 'METADATA' }, entityType: { S: 'league' } })), ScannedCount: 2 }
        : { Items: [], ScannedCount: 100, LastEvaluatedKey: continuation };
    }
    assert.equal(command.constructor.name, 'GetItemCommand'); assert.equal(input.ConsistentRead, true);
    if (input.Key.pk.S === 'LEAGUE#live') return { Item: row('LEAGUE#live', 'METADATA', 'league', { leagueId: 'live', email: 'never-output@example.test' }) };
    if (input.Key.sk.S === `league#${hash(['deleted'])}`) return { Item: row(input.Key.pk.S, input.Key.sk.S, 'playerIdentityTombstone', { kind: 'league', ids: ['deleted'] }) };
    return {};
  } };
  const first = await inventoryPage({ client, binding }); assert.equal(first.status, 'partial'); assert.deepEqual(first.leagueIds, []); assert.ok(first.cursor);
  const final = await inventoryPage({ client, binding, cursor: first.cursor });
  assert.equal(final.status, 'complete'); assert.deepEqual(final.leagueIds, ['live']); assert.equal(final.scanned, 102); assert.equal(final.cursor, null);
  assert(!JSON.stringify(final).includes('never-output')); assert(commands.every(command => ['ScanCommand', 'GetItemCommand'].includes(command.constructor.name)));
});

test('inventory refuses repeated continuation, malformed rows and unproved disappearance', async () => {
  const after = { pk: { S: 'x' }, sk: { S: 'y' } };
  const client = { send: async () => ({ Items: [], ScannedCount: 1, LastEvaluatedKey: after }) };
  const page = await inventoryPage({ client, binding });
  await assert.rejects(inventoryPage({ client, binding, cursor: page.cursor }), /did not advance/);
  await assert.rejects(inventoryPage({ binding, client: { send: async () => ({ Items: [{ pk: { S: 'WRONG' } }], ScannedCount: 1 }) } }), /Unexpected inventory/);
  await assert.rejects(inventoryPage({ binding, client: { send: async command => command.constructor.name === 'ScanCommand'
    ? { Items: [{ pk: { S: 'LEAGUE#missing' }, sk: { S: 'METADATA' }, entityType: { S: 'league' } }], ScannedCount: 1 } : {} } }), /Inventory changed/);
});

test('audit remains partial until career and every season are reconciled, with read-only commands', async () => {
  const fixtureValue = fixture();
  const first = await step(fixtureValue); assert.equal(first.status, 'partial'); assert.equal(first.checkedPlayers, 0);
  const career = await step(fixtureValue, first.cursor); assert.equal(career.status, 'partial');
  const complete = await step(fixtureValue, career.cursor); assert.equal(complete.status, 'complete'); assert.equal(complete.checkedPlayers, 1);
  assert.equal(complete.cursor, null); assert(!JSON.stringify(complete).includes('Private')); assert(!JSON.stringify(complete).includes('Must not'));
  assert(fixtureValue.commands.every(command => ['GetItemCommand', 'QueryCommand', 'TransactGetItemsCommand'].includes(command.constructor.name)));
});

test('zero-appearance players require a real CAREER summary and complete safely', async () => {
  const value = fixture([]), first = await step(value);
  assert.equal((await step(value, first.cursor)).status, 'complete');
  value.runtime.store.getSummary = async () => null;
  await assert.rejects(step(value, first.cursor), /Required published summary/);
});

test('audit catches missing or stale publication and changed readiness or directory snapshots', async () => {
  const value = fixture(), first = await step(value);
  value.publication.generation = 'new'; await assert.rejects(step(value, first.cursor), /Player changed/);
  value.publication.generation = 'generation'; value.publication.sourceRevision = 'old'; await assert.rejects(step(value, first.cursor), /not current/);
  value.publication.sourceRevision = 'source'; value.runtime.store.getPublication = async () => null; await assert.rejects(step(value, first.cursor), /not current/);
  const changed = fixture(), prior = await step(changed);
  changed.set(row('LEAGUE#l', 'PLAYER_DIRECTORY', 'playerDirectoryRevision', { revision: 'new' }));
  await assert.rejects(step(changed, prior.cursor), /coverage is not current/);
  const disabled = fixture(); disabled.runtime.readiness = async () => { throw new Error('disabled'); };
  await assert.rejects(step(disabled), /disabled/);
});

test('audit rejects summary totals inconsistent with appearances and season/career coverage', async () => {
  const value = fixture(), first = await step(value);
  value.runtime.store.getSummary = async () => ({ state: { context: { leagueId: 'l', playerId: 'p' }, totals: { ...sum([appearance()]), goals: 5, goalsPerGame: 5 } } });
  await assert.rejects(step(value, first.cursor), /Appearance totals differ/);
  const wrongSeason = fixture(), initial = await step(wrongSeason), career = await step(wrongSeason, initial.cursor);
  wrongSeason.runtime.store.pageMatches = async () => ({ items: [appearance('g', 'other')], cursor: null });
  await assert.rejects(step(wrongSeason, career.cursor), /season is outside/);
});

test('bounded appearance pages resume deterministically without claiming early completion', async () => {
  const matches = Array.from({ length: 21 }, (_, index) => ({ ...appearance(`g${index}`), kickoffAt: new Date(Date.UTC(2026, 0, 22 - index)).toISOString() }));
  const value = fixture(matches), first = await step(value), partial = await step(value, first.cursor);
  assert.equal(partial.status, 'partial'); assert.equal(partial.checkedPlayers, 0);
  assert.deepEqual(await step(value, first.cursor), partial, 'lost local output can replay the same read-only step');
  const career = await step(value, partial.cursor), seasonPage = await step(value, career.cursor), done = await step(value, seasonPage.cursor);
  assert.equal(done.status, 'complete');
});

test('source change during an appearance read prevents completion evidence', async () => {
  const value = fixture(), first = await step(value), original = value.runtime.store.pageMatches;
  value.runtime.store.pageMatches = async input => {
    const result = await original(input); value.context.sourceRevision = 'new'; return result;
  };
  await assert.rejects(step(value, first.cursor), /not current/);
});

test('duplicate appearance and nonadvancing match cursor are rejected', async () => {
  const value = fixture(), first = await step(value);
  value.runtime.store.pageMatches = async () => ({ items: [appearance(), appearance()], cursor: null });
  await assert.rejects(step(value, first.cursor), /duplicated/);
  value.runtime.store.pageMatches = async () => ({ items: [], cursor: 'same' });
  const partial = await step(value, first.cursor);
  await assert.rejects(step(value, partial.cursor), /Invalid appearance continuation/);
});

test('completed sweep count must match all active canonical directory players', async () => {
  const value = fixture([]), key = 'LEAGUE#l|HISTORY_SWEEP', sweep = JSON.parse(value.rows.get(key).data.S);
  value.set(row('LEAGUE#l', 'HISTORY_SWEEP', 'playerHistorySweep', { ...sweep, checked: 2, enqueued: 2 }));
  const first = await step(value); await assert.rejects(step(value, first.cursor), /coverage differs/);
  const alias = fixture(); alias.context.playerId = 'root'; await assert.rejects(step(alias), /not current/);
});
