import assert from 'node:assert/strict';
import test from 'node:test';
import { BatchGetItemCommand, GetItemCommand, TransactWriteItemsCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { OwnerPlayerProfileService } from '../data/owner-player-profile.js';
import { historyRow, historyKey, historyHash, type HistoryItem } from '../data/player-history-model.js';
import { profileNameWorkSchema, playerPresentationSchema, profileWorkPartition, profileWorkReference, profileWorkReferenceSchema } from '../data/player-profile-work.js';

const at = '2026-10-04T00:00:00.000Z', userId = 'account-subject', email = 'private@example.test';
const input = { playerId: 'root', userId, userIds: [userId, email] };
const keyOf = (row: HistoryItem) => JSON.stringify([row.pk.S, row.sk.S]);
const body = (row: HistoryItem) => JSON.parse(row.data.S!);
class Memory {
  rows = new Map<string, HistoryItem>(); transactions: TransactWriteItem[][] = [];
  beforeCommit: (() => void) | null = null; loseAcknowledgement = false;
  seed(pk: string, sk: string, type: string, value: unknown) { const row = historyRow(pk, sk, type, value); this.rows.set(keyOf(row), row); return row; }
  get(pk: string, sk: string) { return this.rows.get(keyOf(historyKey(pk, sk))); }
  remove(pk: string, sk: string) { this.rows.delete(keyOf(historyKey(pk, sk))); }
  async send(command: unknown): Promise<unknown> {
    if (command instanceof GetItemCommand) {
      assert.equal(command.input.ConsistentRead, true); return { Item: structuredClone(this.rows.get(keyOf(command.input.Key!))) };
    }
    if (command instanceof BatchGetItemCommand) {
      const request = command.input.RequestItems!.table; assert.equal(request.ConsistentRead, true); assert(request.Keys!.length <= 100);
      return { Responses: { table: request.Keys!.flatMap(key => { const row = this.rows.get(keyOf(key)); return row ? [structuredClone(row)] : []; }) } };
    }
    assert(command instanceof TransactWriteItemsCommand, 'owner service never queries or scans');
    const actions = command.input.TransactItems!; this.transactions.push(structuredClone(actions)); assert(actions.length <= 100);
    const hook = this.beforeCommit; this.beforeCommit = null; hook?.();
    const validity = actions.map(action => {
      const operation = action.Put ?? action.ConditionCheck; assert(operation);
      const key = action.Put?.Item ?? action.ConditionCheck!.Key!; const row = this.rows.get(keyOf(key));
      return operation.ConditionExpression!.split(' AND ').every(expression => {
        const absent = expression.match(/^attribute_not_exists\((.+)\)$/); if (absent) return !row?.[absent[1]];
        const equal = expression.match(/^(\S+) = (\S+)$/); assert(equal);
        return JSON.stringify(row?.[operation.ExpressionAttributeNames![equal[1]]]) === JSON.stringify(operation.ExpressionAttributeValues![equal[2]]);
      });
    });
    if (validity.some(value => !value)) throw Object.assign(new Error('changed'), { name: 'TransactionCanceledException',
      CancellationReasons: validity.map(value => ({ Code: value ? 'None' : 'ConditionalCheckFailed' })) });
    for (const action of actions) if (action.Put) this.rows.set(keyOf(action.Put.Item!), structuredClone(action.Put.Item!));
    if (this.loseAcknowledgement && actions.some(action => action.Put)) { this.loseAcknowledgement = false; throw new Error('lost acknowledgement'); }
    return {};
  }
}
function fixture() {
  const client = new Memory();
  client.seed('PLAYER_IDENTITY', 'CONTROL', 'playerIdentityControl', { mode: 'fenced', coverage: 'unknown', epoch: 'epoch', writerVersion: 1 });
  client.seed('PLAYER#root', 'IDENTITY', 'playerIdentity', { playerId: 'root', rootId: 'root', members: ['root'], identityVersion: 1,
    writeVersion: 'original', displayName: 'Original name', formerNames: [] });
  client.seed('PLAYER#root', 'PROFILE', 'player', { playerId: 'root', nickname: 'Original name', claimedByUserId: userId });
  client.seed('PLAYER_HISTORY', 'CONTROL', 'playerHistoryReadiness', { version: 1, enabled: true, revision: '11111111-1111-4111-8111-111111111111', ruleVersion: 1, activatedAt: at,
    manifest: { version: 1, writerVersion: 1, writerSha: 'a'.repeat(40), tableName: 'table', accountId: '301691475109', region: 'ap-southeast-2', reviewedPlan: 'https://github.com/ajfisher/3fc/pull/209', drainedAt: at, ruleVersion: 1 } });
  const service = new OwnerPlayerProfileService(client, 'table', { now: () => at, processingEnabled: () => true });
  const update = (pk: string, sk: string, patch: Record<string, unknown>) => {
    const row = client.get(pk, sk)!; row.data = { S: JSON.stringify({ ...body(row), ...patch }) };
  };
  const rename = async (displayName = 'New name', idempotencyKey = 'request-1') => service.rename({ ...input, displayName, idempotencyKey,
    expectedRevision: (await service.read(input)).revision });
  return { client, service, update, rename };
}
const rowsOf = (client: Memory, type: string) => [...client.rows.values()].filter(row => row.entityType.S === type);

test('owner reads expose safe canonical details independently of processing/readiness and league ACLs', async () => {
  const { client, service, update } = fixture(); client.remove('PLAYER_HISTORY', 'CONTROL');
  const value = await service.read(input);
  assert.deepEqual(Object.keys(value).sort(), ['displayName', 'hasPortrait', 'playerId', 'revision']);
  assert.equal(value.playerId, 'root'); assert.equal(value.hasPortrait, false); assert.match(value.revision, /^[a-f0-9]{64}$/);
  client.seed('LEAGUE#league', 'ACL#USER#admin', 'acl', { userId: 'admin', role: 'admin', leagueId: 'league' });
  await assert.rejects(service.read({ playerId: 'root', userId: 'admin' }), error => (error as any).status === 403);
  update('PLAYER#root', 'PROFILE', { claimedByUserId: null });
  await assert.rejects(service.read(input), error => (error as any).status === 403);
  assert(client.transactions.every(actions => actions.every(action => action.ConditionCheck)));
});

test('rename atomically changes canonical presentation and records bounded durable work without account data', async () => {
  const { client, rename } = fixture(); const value = await rename('  Xavier David  ');
  assert.equal(value.displayName, 'Xavier David');
  assert.equal(body(client.get('PLAYER#root', 'PROFILE')!).nickname, value.displayName);
  const identity = body(client.get('PLAYER#root', 'IDENTITY')!);
  assert.equal(identity.displayName, value.displayName); assert.deepEqual(identity.formerNames, ['Original name']); assert.equal(identity.identityVersion, 1);
  const presentation = playerPresentationSchema.parse(body(client.get('PLAYER#root', 'PRESENTATION')!));
  const work = rowsOf(client, 'playerProfileNameWork'); assert.equal(work.length, 1);
  const job = profileNameWorkSchema.parse(body(work[0])); assert.equal(job.nameRevision, presentation.nameRevision); assert.equal(job.status, 'pending');
  assert.deepEqual(job.members, ['root']); assert.equal(job.cursor, null);
  const committed = client.transactions.find(actions => actions.some(action => action.Put?.Item?.entityType?.S === 'playerProfileNameWork'))!;
  assert.equal(committed.filter(action => action.Put).length, 5, 'profile, identity, presentation, work and receipt commit together');
  const receipt = rowsOf(client, 'playerProfileReceipt'); assert.equal(receipt.length, 1);
  assert(!JSON.stringify([receipt, work]).includes(email)); assert(!JSON.stringify(receipt).includes(userId));
  const ref = profileWorkReference('root', job.nameRevision); assert.equal(ref.playerHash, historyHash('root'));
  assert.equal(profileWorkPartition('root'), `PLAYER_PROFILE_WORK#${ref.playerHash}`); assert.deepEqual(profileWorkReferenceSchema.parse(ref), ref);
});

test('semantic revisions ignore ordinary identity write activity but reject changed presentation', async () => {
  const { client, service, update } = fixture(); const before = await service.read(input);
  update('PLAYER#root', 'IDENTITY', { writeVersion: 'ordinary-game' }); assert.equal((await service.read(input)).revision, before.revision);
  client.beforeCommit = () => update('PLAYER#root', 'IDENTITY', { writeVersion: 'raced-game' });
  const value = await service.rename({ ...input, displayName: 'Changed', expectedRevision: before.revision, idempotencyKey: 'one' });
  assert.equal(value.displayName, 'Changed'); assert.notEqual(value.revision, before.revision);
  await assert.rejects(service.rename({ ...input, displayName: 'Stale', expectedRevision: before.revision, idempotencyKey: 'two' }), error => (error as any).status === 409);
  assert.equal(rowsOf(client, 'playerProfileNameWork').length, 1);
});

test('lost acknowledgement and exact retries replay one immutable receipt without repeating a rename', async () => {
  const { client, service } = fixture(); const expectedRevision = (await service.read(input)).revision;
  const request = { ...input, displayName: 'First rename', expectedRevision, idempotencyKey: 'one' };
  client.loseAcknowledgement = true; const first = await service.rename(request);
  assert.deepEqual(await service.rename(request), first);
  const second = await service.rename({ ...input, displayName: 'Second rename', expectedRevision: first.revision, idempotencyKey: 'two' });
  assert.deepEqual(await service.rename(request), first, 'replay does not restore an old name');
  assert.equal((await service.read(input)).displayName, second.displayName); assert.equal(rowsOf(client, 'playerProfileNameWork').length, 2);
  await assert.rejects(service.rename({ ...request, displayName: 'Different request' }), error => (error as any).code === 'owner_profile_request_conflict');
});

test('committed retries survive processing/readiness pauses while new writes and revoked owners remain blocked', async () => {
  for (const pause of ['environment', 'disabled-readiness', 'missing-readiness']) {
    const { client, service, update } = fixture();
    const request = { ...input, displayName: 'Committed name', expectedRevision: (await service.read(input)).revision, idempotencyKey: 'saved' };
    const saved = await service.rename(request);
    const writesBefore = client.transactions.filter(actions => actions.some(action => action.Put)).length;
    if (pause === 'disabled-readiness') update('PLAYER_HISTORY', 'CONTROL', { enabled: false });
    if (pause === 'missing-readiness') client.remove('PLAYER_HISTORY', 'CONTROL');
    const paused = new OwnerPlayerProfileService(client, 'table', { now: () => at, processingEnabled: () => pause !== 'environment' });
    assert.deepEqual(await paused.rename(request), saved);
    await assert.rejects(paused.rename({ ...request, displayName: 'Different payload' }), error => (error as any).code === 'owner_profile_request_conflict');
    await assert.rejects(paused.rename({ ...request, displayName: 'New write', expectedRevision: saved.revision, idempotencyKey: 'new' }),
      error => ['owner_profile_unavailable', 'history_unavailable'].includes((error as any).code));
    update('PLAYER#root', 'PROFILE', { claimedByUserId: 'stranger' });
    await assert.rejects(paused.rename(request), error => (error as any).status === 403);
    assert.equal(client.transactions.filter(actions => actions.some(action => action.Put)).length, writesBefore);
    assert.equal(rowsOf(client, 'playerProfileNameWork').length, 1);
  }
});

test('ownership is rechecked for alias requests, every replay and concurrent mutations', async () => {
  const { client, service, update } = fixture(); update('PLAYER#root', 'IDENTITY', { members: ['root', 'alias'] });
  client.seed('PLAYER#alias', 'IDENTITY', 'playerIdentity', { playerId: 'alias', rootId: 'root', members: [], identityVersion: 1, writeVersion: 'a', displayName: 'Alias', formerNames: [] });
  const aliasInput = { ...input, playerId: 'alias' }, previous = await service.read(aliasInput);
  const request = { ...aliasInput, displayName: 'Alias rename', expectedRevision: previous.revision, idempotencyKey: 'alias' };
  assert.equal((await service.rename(request)).playerId, 'root'); assert.equal(body(client.get('PLAYER#alias', 'IDENTITY')!).displayName, 'Alias');
  update('PLAYER#root', 'PROFILE', { claimedByUserId: 'stranger' });
  await assert.rejects(service.rename(request), error => (error as any).status === 403);
  update('PLAYER#root', 'PROFILE', { claimedByUserId: userId }); const current = await service.read(input);
  client.beforeCommit = () => update('PLAYER#root', 'PROFILE', { claimedByUserId: 'stranger' });
  await assert.rejects(service.rename({ ...input, displayName: 'Raced', expectedRevision: current.revision, idempotencyKey: 'race' }), error => (error as any).status === 403);
  assert.equal(rowsOf(client, 'playerProfileNameWork').length, 1); assert.equal(body(client.get('PLAYER#root', 'IDENTITY')!).displayName, 'Alias rename');
});

test('saved rename replay after consolidation rechecks the new canonical owner without restoring old presentation', async () => {
  const { client, service, update } = fixture();
  const request = { ...input, displayName: 'Before consolidation', expectedRevision: (await service.read(input)).revision, idempotencyKey: 'original' };
  const saved = await service.rename(request);
  // Consolidation retains another profile owned by the same account and retires
  // the submitted ID. The receipt remains at the original submitted-ID key.
  update('PLAYER#root', 'IDENTITY', { rootId: 'retained', members: [], identityVersion: 2, writeVersion: 'retired' });
  client.seed('PLAYER#retained', 'IDENTITY', 'playerIdentity', { playerId: 'retained', rootId: 'retained', members: ['retained', 'root'],
    identityVersion: 2, writeVersion: 'merged', displayName: 'Consolidated presentation', formerNames: ['Before consolidation'] });
  client.seed('PLAYER#retained', 'PROFILE', 'player', { playerId: 'retained', nickname: 'Retained', claimedByUserId: userId });
  assert.deepEqual(await service.rename(request), saved, 'the original immutable response is replayed');
  assert.equal((await service.read(input)).displayName, 'Consolidated presentation');
  assert.equal(rowsOf(client, 'playerProfileNameWork').length, 1);
  assert.equal(client.get('PLAYER#retained', 'PRESENTATION'), undefined, 'replay creates no new presentation or work');
  update('PLAYER#retained', 'PROFILE', { claimedByUserId: 'stranger' });
  await assert.rejects(service.rename(request), error => (error as any).status === 403,
    'ownership of the retired submitted profile cannot authorize receipt replay');
});

test('disabled processing, readiness revocation and paused identity control cannot commit owner writes', async () => {
  for (const scenario of ['disabled', 'readiness', 'readiness-race', 'paused']) {
    const { client, service, update } = fixture(); const expectedRevision = (await service.read(input)).revision;
    const active = scenario === 'disabled' ? new OwnerPlayerProfileService(client, 'table', { processingEnabled: () => false }) : service;
    if (scenario === 'readiness') client.remove('PLAYER_HISTORY', 'CONTROL');
    if (scenario === 'readiness-race') client.beforeCommit = () => client.remove('PLAYER_HISTORY', 'CONTROL');
    if (scenario === 'paused') update('PLAYER_IDENTITY', 'CONTROL', { mode: 'paused' });
    await assert.rejects(active.rename({ ...input, displayName: 'Not committed', expectedRevision, idempotencyKey: scenario }));
    assert.equal(rowsOf(client, 'playerProfileNameWork').length, 0); assert.equal(rowsOf(client, 'playerProfileReceipt').length, 0);
    assert.equal(body(client.get('PLAYER#root', 'PROFILE')!).nickname, 'Original name');
  }
});

test('unchanged names are replayable no-ops, and invalid names or overflowing history never write', async () => {
  const { client, service, update, rename } = fixture(); const initial = await service.read(input);
  const noop = await rename('Original name'); assert.deepEqual(noop, initial); assert.equal(rowsOf(client, 'playerProfileNameWork').length, 0);
  for (const displayName of ['', '  ', 'a'.repeat(81), 'bad\u0000name', '\nname', '\ud800'])
    await assert.rejects(service.rename({ ...input, displayName, expectedRevision: initial.revision, idempotencyKey: 'invalid' }), error => (error as any).status === 400);
  for (const idempotencyKey of ['', 'has spaces', 'a'.repeat(129), 'λ'])
    await assert.rejects(service.rename({ ...input, displayName: 'Valid name', expectedRevision: initial.revision, idempotencyKey }), error => (error as any).status === 400);
  update('PLAYER#root', 'IDENTITY', { formerNames: Array.from({ length: 20 }, (_, i) => `Former ${i}`) });
  await assert.rejects(rename('Another name', 'history'), error => (error as any).code === 'owner_profile_name_history_full');
  assert.equal(rowsOf(client, 'playerProfileNameWork').length, 0);
});
