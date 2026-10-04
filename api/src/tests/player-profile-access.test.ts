import assert from 'node:assert/strict';
import test from 'node:test';
import { BatchGetItemCommand, GetItemCommand, QueryCommand, TransactWriteItemsCommand, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { PlayerProfileAccess } from '../data/player-profile-access.js';
import { historyRow, historyKey, historyHash, type HistoryItem } from '../data/player-history-model.js';
import { aclSk, playerClaimSk } from '../data/keys.js';
import { identityDirectorySk, identityLeagueSk, identityTombstoneSk } from '../data/player-identity.js';

const account = 'account-subject', email = 'private@example.test';
const itemKey = (item: HistoryItem) => JSON.stringify([item.pk!.S, item.sk!.S]);
const data = (item: HistoryItem) => JSON.parse(item.data!.S!);
class MemoryClient {
  items = new Map<string, HistoryItem>();
  queries: QueryCommand['input'][] = []; batches: BatchGetItemCommand['input'][] = [];
  transactions: TransactWriteItem[][] = [];
  beforeCommit: (() => void) | null = null;
  queryOverride: ((result: { Items: HistoryItem[]; LastEvaluatedKey?: HistoryItem }) => unknown) | null = null;
  batchOverride: (() => unknown) | null = null;
  seed(pk: string, sk: string, type: string, value: unknown) {
    const item = historyRow(pk, sk, type, value); this.items.set(itemKey(item), item); return item;
  }
  remove(pk: string, sk: string) { this.items.delete(itemKey(historyKey(pk, sk))); }
  async send(command: unknown): Promise<unknown> {
    if (command instanceof BatchGetItemCommand) {
      this.batches.push(structuredClone(command.input));
      if (this.batchOverride) return this.batchOverride();
      const requests = command.input.RequestItems!; assert.deepEqual(Object.keys(requests), ['table']);
      assert.equal(requests.table.ConsistentRead, true); const keys = requests.table.Keys!; assert(keys.length <= 100);
      return { Responses: { table: keys.flatMap(key => {
        const item = this.items.get(itemKey(key)); return item ? [structuredClone(item)] : [];
      }) } };
    }
    if (command instanceof GetItemCommand) assert.fail('all point reads must use bounded cache prefetch');
    if (command instanceof QueryCommand) {
      const input = command.input; this.queries.push(structuredClone(input));
      assert.equal(input.ConsistentRead, true); assert.equal(input.IndexName, undefined); assert.equal(input.FilterExpression, undefined);
      assert(input.Limit && input.Limit <= 20);
      const values = input.ExpressionAttributeValues!, pk = values[':pk'].S!, prefix = values[':prefix'].S!, after = input.ExclusiveStartKey?.sk?.S;
      const rows = [...this.items.values()].filter(item => item.pk!.S === pk && item.sk!.S!.startsWith(prefix)
        && (!after || Buffer.compare(Buffer.from(item.sk!.S!), Buffer.from(after)) > 0))
        .sort((left, right) => Buffer.compare(Buffer.from(left.sk!.S!), Buffer.from(right.sk!.S!)));
      const items = rows.slice(0, input.Limit), last = items.at(-1);
      const result = { Items: structuredClone(items), ...(last && rows.length > items.length ? { LastEvaluatedKey: historyKey(pk, last.sk!.S!) } : {}) };
      return this.queryOverride ? this.queryOverride(result) : result;
    }
    assert(command instanceof TransactWriteItemsCommand, 'no writes/scans/alternate APIs');
    const actions = command.input.TransactItems!; this.transactions.push(actions);
    assert(actions.length <= 100); assert(actions.every(action => action.ConditionCheck && !action.Put && !action.Delete && !action.Update));
    this.beforeCommit?.();
    const valid = actions.map(action => {
      const check = action.ConditionCheck!, stored = this.items.get(itemKey(check.Key!));
      return check.ConditionExpression!.split(' AND ').every(expression => {
        const absent = expression.match(/^attribute_not_exists\((.+)\)$/); if (absent) return !stored?.[absent[1]];
        const equality = expression.match(/^(\S+) = (\S+)$/); assert(equality);
        return JSON.stringify(stored?.[check.ExpressionAttributeNames![equality[1]]]) === JSON.stringify(check.ExpressionAttributeValues![equality[2]]);
      });
    });
    if (valid.some(value => !value)) throw Object.assign(new Error('authority changed'), { name: 'TransactionCanceledException',
      CancellationReasons: valid.map(value => ({ Code: value ? 'None' : 'ConditionalCheckFailed' })) });
    return {};
  }
}
function addPlayer(client: MemoryClient, id: string, owner: string | null, leagueId = 'league') {
  client.seed(`PLAYER#${id}`, 'IDENTITY', 'playerIdentity', { playerId: id, rootId: id, members: [id], identityVersion: 1,
    writeVersion: 'w1', displayName: `Name ${id}`, formerNames: [] });
  client.seed(`PLAYER#${id}`, 'PROFILE', 'player', { playerId: id, nickname: `Name ${id}`, claimedByUserId: owner,
    email: 'never-return@example.test', notificationPreferences: { secret: true } });
  client.seed(`PLAYER#${id}`, identityLeagueSk(leagueId), 'playerLeagueMembership', { playerId: id, leagueId });
  client.seed(`LEAGUE#${leagueId}`, identityDirectorySk(id), 'leaguePlayer', { playerId: id, nickname: `Name ${id}`, active: true });
  if (owner) client.seed(`USER#${owner}`, playerClaimSk(id), 'playerClaim', { playerId: id, userId: owner });
}
function fixture() {
  const client = new MemoryClient();
  client.seed('PLAYER_IDENTITY', 'CONTROL', 'playerIdentityControl', { mode: 'fenced', coverage: 'unknown', epoch: 'e1', writerVersion: 1 });
  client.seed('LEAGUE#league', 'METADATA', 'league', { leagueId: 'league', name: 'Test league' });
  client.seed('LEAGUE#league', 'PLAYER_DIRECTORY', 'playerDirectoryRevision', { revision: 'd1' });
  for (const userId of [account, email]) client.seed(`USER#${userId}`, 'PLAYER_CLAIMS_REVISION', 'playerClaimsRevision', { revision: 'c1' });
  addPlayer(client, 'owner', account); addPlayer(client, 'target', null);
  return { client, access: new PlayerProfileAccess(client, 'table'), caller: { userId: account, userIds: [account, email], leagueId: 'league' } };
}
function claimRoot(client: MemoryClient, id: string, owner: string | null) {
  const row = client.items.get(itemKey(historyKey(`PLAYER#${id}`, 'PROFILE')))!;
  row.data = { S: JSON.stringify({ ...data(row), claimedByUserId: owner }) };
}
function addAliases(client: MemoryClient, rootId: string, aliases: string[]) {
  const root = client.items.get(itemKey(historyKey(`PLAYER#${rootId}`, 'IDENTITY')))!;
  root.data = { S: JSON.stringify({ ...data(root), members: [rootId, ...aliases] }) };
  for (const alias of aliases) client.seed(`PLAYER#${alias}`, 'IDENTITY', 'playerIdentity', { playerId: alias, rootId,
    members: [], writeVersion: 'w1', identityVersion: 1, displayName: alias, formerNames: [] });
}
async function discoverAll(access: PlayerProfileAccess, caller: { leagueId: string; userId: string; userIds: string[] }, limit = 1) {
  const found: string[] = []; let cursor: string | undefined;
  for (let pageIndex = 0; pageIndex < 100; pageIndex++) {
    const page = await access.discover({ ...caller, cursor, limit });
    found.push(...page.players.map(player => player.playerId));
    if (!page.cursor) return found;
    cursor = page.cursor;
  }
  assert.fail('discovery did not terminate');
}

test('a verified canonical participant can read another profile without gaining owner authority', async () => {
  const { client, access, caller } = fixture();
  const grant = await access.authorize({ ...caller, playerId: 'target', viewerPlayerId: 'owner' });
  assert.deepEqual(grant.player, { playerId: 'target', displayName: 'Name target', hasPortrait: false });
  assert.deepEqual(grant.league, { leagueId: 'league', name: 'Test league' }); assert.equal(grant.owner, false);
  assert.equal((await access.authorize({ ...caller, playerId: 'owner' })).owner, true);
  await assert.rejects(access.authorize({ ...caller, playerId: 'target', viewerPlayerId: 'target' }), /cannot access/);
  await assert.rejects(access.authorize({ ...caller, playerId: 'target' }), /cannot access/);
  assert.equal(client.queries.length, 0, 'authorization never scans account claims');
});

test('each valid league ACL grants reading only; forged and cross-league roles do not', async () => {
  for (const role of ['admin', 'scorekeeper', 'viewer']) {
    const { client, access, caller } = fixture();
    client.seed('LEAGUE#league', aclSk(email), 'acl', { leagueId: 'league', userId: email, role });
    assert.equal((await access.authorize({ ...caller, playerId: 'target' })).owner, false);
    assert.equal((await access.authorize({ ...caller, playerId: 'target', viewerPlayerId: 'obsolete-hint' })).owner, false,
      'an unnecessary stale participant hint does not defeat independently valid ACL access');
    assert.equal((await access.discover(caller)).hasLeagueAcl, true);
  }
  const { client, access, caller } = fixture();
  client.seed('LEAGUE#other', aclSk(account), 'acl', { leagueId: 'other', userId: account, role: 'admin' });
  await assert.rejects(access.authorize({ ...caller, playerId: 'target' }), /cannot access/);
  client.seed('LEAGUE#league', aclSk(account), 'acl', { leagueId: 'other', userId: account, role: 'admin' });
  await assert.rejects(access.authorize({ ...caller, playerId: 'target' }));
});

test('canonical aliases use the root current claim and never trust an alias stale owner', async () => {
  const { client, access, caller } = fixture();
  client.seed('PLAYER#alias/slash%λ', 'IDENTITY', 'playerIdentity', { playerId: 'alias/slash%λ', rootId: 'owner', members: [],
    identityVersion: 1, writeVersion: 'wa', displayName: 'Alias', formerNames: [] });
  const root = client.items.get(itemKey(historyKey('PLAYER#owner', 'IDENTITY')))!;
  root.data = { S: JSON.stringify({ ...data(root), members: ['owner', 'alias/slash%λ'] }) };
  client.seed('PLAYER#alias/slash%λ', 'PROFILE', 'player', { playerId: 'alias/slash%λ', nickname: 'Alias', claimedByUserId: 'stranger' });
  const grant = await access.authorize({ ...caller, playerId: 'alias/slash%λ' });
  assert.equal(grant.player.playerId, 'owner'); assert.equal(grant.owner, true);
  claimRoot(client, 'owner', 'stranger');
  await assert.rejects(access.authorize({ ...caller, playerId: 'alias/slash%λ' }), /cannot access/);
});

test('owner and viewer scope require an active directory plus matching league membership', async () => {
  for (const scenario of ['missing-membership', 'inactive', 'wrong-membership', 'foreign-player']) {
    const { client, access, caller } = fixture();
    if (scenario === 'missing-membership') client.remove('PLAYER#owner', identityLeagueSk('league'));
    if (scenario === 'inactive') client.seed('LEAGUE#league', identityDirectorySk('owner'), 'leaguePlayer', { playerId: 'owner', active: false, nickname: 'Owner' });
    if (scenario === 'wrong-membership') client.seed('PLAYER#owner', identityLeagueSk('league'), 'playerLeagueMembership', { playerId: 'owner', leagueId: 'other' });
    if (scenario === 'foreign-player') {
      client.remove('PLAYER#owner', identityLeagueSk('league')); client.remove('LEAGUE#league', identityDirectorySk('owner'));
      client.seed('PLAYER#owner', identityLeagueSk('other'), 'playerLeagueMembership', { playerId: 'owner', leagueId: 'other' });
    }
    await assert.rejects(access.authorize({ ...caller, playerId: 'target', viewerPlayerId: 'owner' }));
  }
});

test('final composition fence rejects ownership, ACL, directory and root revocation races', async () => {
  for (const scenario of ['owner', 'acl', 'directory', 'root', 'league']) {
    const { client, access, caller } = fixture();
    if (scenario === 'acl') client.seed('LEAGUE#league', aclSk(account), 'acl', { leagueId: 'league', userId: account, role: 'viewer' });
    const grant = await access.authorize({ ...caller, playerId: 'target', ...(scenario === 'acl' ? {} : { viewerPlayerId: 'owner' }) });
    client.beforeCommit = () => {
      client.beforeCommit = null;
      if (scenario === 'owner') claimRoot(client, 'owner', 'stranger');
      if (scenario === 'acl') client.remove('LEAGUE#league', aclSk(account));
      if (scenario === 'directory') client.seed('LEAGUE#league', 'PLAYER_DIRECTORY', 'playerDirectoryRevision', { revision: 'd2' });
      if (scenario === 'root') {
        const row = client.items.get(itemKey(historyKey('PLAYER#owner', 'IDENTITY')))!;
        row.data = { S: JSON.stringify({ ...data(row), writeVersion: 'w2' }) };
      }
      if (scenario === 'league') client.seed('PLAYER_IDENTITY_TOMBSTONE', identityTombstoneSk('league', ['league']), 'playerIdentityTombstone', { kind: 'league', ids: ['league'] });
    };
    await assert.rejects(access.assertCurrent(grant.checks), error => (error as { code?: string }).code === 'player_profile_changed');
  }
});

test('discovery paginates both claim namespaces and trusted identities while preserving opaque player IDs', async () => {
  const { client, access, caller } = fixture();
  const long = 'x'.repeat(1020), opaque = 'email-owned/λ%'; addPlayer(client, long, account); addPlayer(client, opaque, email);
  assert.equal((await access.authorize({ ...caller, playerId: opaque })).owner, true, 'legacy email claim belongs to the verified account alias');
  let cursor: string | undefined, pages = 0; const found: string[] = [];
  do {
    const page = await access.discover({ ...caller, limit: 1, cursor });
    assert.equal(page.leagueId, 'league'); assert.equal(page.hasLeagueAcl, false); assert.equal(page.complete, page.cursor === null);
    page.players.forEach(player => found.push(player.playerId)); pages++;
    assert(!JSON.stringify(page).includes(email)); assert(!JSON.stringify(page).includes('never-return'));
    if (page.cursor) assert(!Buffer.from(page.cursor, 'base64url').toString().includes(email));
    cursor = page.cursor ?? undefined;
  } while (cursor && pages < 10);
  assert.equal(cursor, undefined); assert.deepEqual(found.sort(), ['owner', long, opaque].sort());
  assert.equal(client.queries.length, pages, 'exactly one bounded claims query per page');
  assert(client.queries.some(query => query.ExpressionAttributeValues![':prefix'].S === 'PLAYER_HASH#'));
});

test('twenty raw claims are a hard page bound and stale ownership hints are filtered', async () => {
  const { client, access, caller } = fixture();
  for (let index = 0; index < 25; index++) addPlayer(client, `extra-${String(index).padStart(2, '0')}`, account);
  claimRoot(client, 'extra-00', 'stranger');
  const first = await access.discover(caller);
  assert.equal(first.players.length, 19); assert(first.cursor); assert.equal(first.complete, false);
  assert(!first.players.some(player => player.playerId === 'extra-00')); assert.equal(client.queries.length, 1);
  assert(client.transactions.at(-1)!.length <= 100); assert(client.batches.every(batch => batch.RequestItems!.table.Keys!.length <= 100));
});

test('twenty full canonical alias closures use bounded batch reads and fit one authority fence', async () => {
  const { client, access, caller } = fixture();
  client.remove(`USER#${account}`, playerClaimSk('owner'));
  for (let group = 0; group < 20; group++) {
    const root = `group-${String(group).padStart(2, '0')}`; addPlayer(client, root, account);
    const aliases = Array.from({ length: 19 }, (_, index) => `${root}-alias-${index}`);
    const row = client.items.get(itemKey(historyKey(`PLAYER#${root}`, 'IDENTITY')))!;
    row.data = { S: JSON.stringify({ ...data(row), members: [root, ...aliases] }) };
    for (const alias of aliases) client.seed(`PLAYER#${alias}`, 'IDENTITY', 'playerIdentity', { playerId: alias, rootId: root,
      members: [], writeVersion: 'w1', identityVersion: 1, displayName: alias, formerNames: [] });
  }
  const page = await access.discover(caller);
  assert.equal(page.players.length, 20); assert.equal(client.queries.length, 1);
  assert.equal(client.batches.length, 8, 'scope + roots + five metadata/alias batches + canonical claims');
  assert(client.batches.every(batch => batch.RequestItems!.table.Keys!.length <= 100));
  assert.equal(client.transactions.length, 1); assert(client.transactions[0].length <= 90);
});

test('discovery cursors bind account set, league, claim revision, directory and identity epoch', async () => {
  for (const change of ['account', 'league', 'claim', 'directory', 'epoch']) {
    const { client, access, caller } = fixture(); const first = await access.discover(caller); assert(first.cursor);
    let input = { ...caller, cursor: first.cursor };
    if (change === 'account') input = { ...input, userId: email, userIds: [email, account] };
    if (change === 'league') {
      client.seed('LEAGUE#other', 'METADATA', 'league', { leagueId: 'other', name: 'Other' }); input.leagueId = 'other';
    }
    if (change === 'claim') client.seed(`USER#${email}`, 'PLAYER_CLAIMS_REVISION', 'playerClaimsRevision', { revision: 'c2' });
    if (change === 'directory') client.seed('LEAGUE#league', 'PLAYER_DIRECTORY', 'playerDirectoryRevision', { revision: 'd2' });
    if (change === 'epoch') client.seed('PLAYER_IDENTITY', 'CONTROL', 'playerIdentityControl', { mode: 'fenced', coverage: 'unknown', epoch: 'e2', writerVersion: 1 });
    await assert.rejects(access.discover(input), error => (error as { code?: string }).code === 'invalid_player_cursor');
  }
});

test('discovery emits each canonical player once across aliases, accounts, namespaces and page boundaries', async () => {
  const { client, access, caller } = fixture();
  const longRoot = 'z'.repeat(1020), legacyRoot = 'legacy-root', longAlias = 'a'.repeat(1020);
  addPlayer(client, longRoot, email); addAliases(client, longRoot, ['early-alias']);
  for (const userId of [account, email]) client.seed(`USER#${userId}`, playerClaimSk('early-alias'), 'playerClaim', { userId, playerId: 'early-alias' });
  // Canonical claims win over earlier alias pages; the first trusted account
  // wins when duplicate canonical claims exist in both account partitions.
  client.seed(`USER#${account}`, playerClaimSk('owner'), 'playerClaim', { userId: account, playerId: 'owner' });
  client.seed(`USER#${email}`, playerClaimSk('owner'), 'playerClaim', { userId: email, playerId: 'owner' });
  addPlayer(client, legacyRoot, account); client.remove(`USER#${account}`, playerClaimSk(legacyRoot));
  addAliases(client, legacyRoot, [longAlias, 'z-alias', 'absent-alias']);
  for (const playerId of [longAlias, 'z-alias']) for (const userId of [account, email])
    client.seed(`USER#${userId}`, playerClaimSk(playerId), 'playerClaim', { userId, playerId });
  // The lexically first present alias is hashed and visited after the ordinary
  // PLAYER# aliases. Missing alias claims must not suppress the representative.
  const found = await discoverAll(access, caller);
  assert.deepEqual(found.sort(), ['owner', longRoot, legacyRoot].sort());
  assert(client.queries.every(query => query.Limit === 1));
  assert(client.transactions.every(actions => actions.length <= 100));
});

test('legacy representative lookups have a fixed 800-key bound for twenty full groups', async () => {
  const { client, access, caller } = fixture(); client.remove(`USER#${account}`, playerClaimSk('owner'));
  for (let group = 0; group < 20; group++) {
    const root = `group-${String(group).padStart(2, '0')}`, aliases = Array.from({ length: 19 }, (_, index) => `${root}-alias-${index}`);
    addPlayer(client, root, account); client.remove(`USER#${account}`, playerClaimSk(root)); addAliases(client, root, aliases);
    client.seed(`USER#${account}`, playerClaimSk(aliases[18]), 'playerClaim', { userId: account, playerId: aliases[18] });
  }
  const page = await access.discover(caller);
  assert.equal(page.players.length, 20); assert.equal(client.queries.length, 1);
  const claimKeys = client.batches.flatMap(batch => batch.RequestItems!.table.Keys!)
    .filter(key => key.pk.S!.startsWith('USER#') && (key.sk.S!.startsWith('PLAYER#') || key.sk.S!.startsWith('PLAYER_HASH#')));
  assert.equal(claimKeys.length, 800, 'twenty roots x twenty members x two accounts, including absent candidates');
  assert(client.batches.every(batch => batch.RequestItems!.table.Keys!.length <= 100));
  assert.equal(client.transactions.length, 1); assert(client.transactions[0].length <= 90);
});

test('representative claim presence, ownership and closure races fail the page fence', async () => {
  for (const change of ['insert-root', 'remove-alias', 'ownership', 'closure']) {
    const { client, access, caller } = fixture();
    client.remove(`USER#${account}`, playerClaimSk('owner')); addAliases(client, 'owner', ['alias']);
    client.seed(`USER#${email}`, playerClaimSk('alias'), 'playerClaim', { userId: email, playerId: 'alias' });
    // Advance to the email PLAYER# page while the same claims revision holds.
    const first = await access.discover(caller), second = await access.discover({ ...caller, cursor: first.cursor! });
    client.beforeCommit = () => {
      client.beforeCommit = null;
      if (change === 'insert-root') client.seed(`USER#${account}`, playerClaimSk('owner'), 'playerClaim', { userId: account, playerId: 'owner' });
      if (change === 'remove-alias') client.remove(`USER#${email}`, playerClaimSk('alias'));
      if (change === 'insert-root' || change === 'remove-alias') client.seed(`USER#${change === 'insert-root' ? account : email}`, 'PLAYER_CLAIMS_REVISION', 'playerClaimsRevision', { revision: 'c2' });
      if (change === 'ownership') claimRoot(client, 'owner', 'stranger');
      if (change === 'closure') {
        const root = client.items.get(itemKey(historyKey('PLAYER#owner', 'IDENTITY')))!;
        root.data = { S: JSON.stringify({ ...data(root), writeVersion: 'changed' }) };
      }
    };
    await assert.rejects(access.discover({ ...caller, cursor: second.cursor! }), error => (error as { code?: string }).code === 'player_profile_changed');
  }
});

test('unqueried canonical and fallback claim candidates must have valid record type and exact account/player', async () => {
  for (const malformed of ['type', 'account', 'player', 'alias']) {
    const { client, access, caller } = fixture(); addAliases(client, 'owner', ['early-alias', 'later-alias']);
    client.seed(`USER#${account}`, playerClaimSk('early-alias'), 'playerClaim', { userId: account, playerId: 'early-alias' });
    if (malformed === 'alias') client.remove(`USER#${account}`, playerClaimSk('owner'));
    const id = malformed === 'alias' ? 'later-alias' : 'owner';
    client.seed(`USER#${email}`, playerClaimSk(id), malformed === 'type' ? 'wrongType' : 'playerClaim', {
      userId: malformed === 'account' ? 'stranger' : email, playerId: malformed === 'player' || malformed === 'alias' ? 'wrong' : id });
    await assert.rejects(access.discover({ ...caller, limit: 1 }));
  }
});

test('discovery final fence rejects a claim change during assembly and never returns a partial page', async () => {
  const { client, access, caller } = fixture();
  client.beforeCommit = () => {
    client.beforeCommit = null; client.seed(`USER#${account}`, 'PLAYER_CLAIMS_REVISION', 'playerClaimsRevision', { revision: 'c2' });
  };
  await assert.rejects(access.discover(caller), error => (error as { code?: string }).code === 'player_profile_changed');
});

test('malformed claims, forged continuations and incomplete batch reads fail explicitly', async () => {
  const malformed = fixture();
  malformed.client.seed(`USER#${account}`, playerClaimSk('forged'), 'playerClaim', { playerId: 'owner', userId: account });
  await assert.rejects(malformed.access.discover(malformed.caller));
  const cursor = fixture(); cursor.client.queryOverride = result => ({ ...result, LastEvaluatedKey: historyKey('USER#stranger', 'PLAYER#owner') });
  await assert.rejects(cursor.access.discover(cursor.caller));
  const batch = fixture(); batch.client.batchOverride = () => ({ Responses: { wrongTable: [] } });
  await assert.rejects(batch.access.discover(batch.caller));
  const invalid = fixture();
  for (const limit of [0, 21, 1.5]) await assert.rejects(invalid.access.discover({ ...invalid.caller, limit }));
  await assert.rejects(invalid.access.discover({ ...invalid.caller, cursor: 'not-valid!' }));
});

test('composition accepts only condition checks and rejects conflicting snapshots', async () => {
  const { access, caller } = fixture(); const grant = await access.authorize({ ...caller, playerId: 'owner' });
  await access.assertCurrent(grant.checks, grant.checks);
  const altered = structuredClone(grant.checks[0]); altered.ConditionCheck!.ExpressionAttributeValues![':data'] = { S: 'changed' };
  await assert.rejects(access.assertCurrent(grant.checks, [altered]), error => (error as { code?: string }).code === 'player_profile_changed');
  await assert.rejects(access.assertCurrent(grant.checks, [{ Put: { TableName: 'table', Item: historyRow('LEAGUE#league', 'METADATA', 'league', {}) } }]));
});


test('portrait presence is target-only safe metadata with present and absent pointer fences', async () => {
  const { client, access, caller } = fixture();
  const jobId = '11111111-1111-4111-8111-111111111111';
  const pointer = { jobId, objectKey: `portraits/${historyHash('target')}/${jobId}.png`, digest: 'a'.repeat(64),
    bytes: 1024, contentType: 'image/png', width: 512, height: 512 };
  const present = { version: 1, playerId: 'target', nameRevision: jobId, portrait: pointer };
  const absent = await access.authorize({ ...caller, playerId: 'target', viewerPlayerId: 'owner' });
  assert.equal(absent.player.hasPortrait, false);
  client.seed('PLAYER#target', 'PRESENTATION', 'playerPresentation', present);
  await assert.rejects(access.assertCurrent(absent.checks), error => (error as any).code === 'player_profile_changed');
  const grant = await access.authorize({ ...caller, playerId: 'target', viewerPlayerId: 'owner' });
  assert.equal(grant.player.hasPortrait, true); assert(!JSON.stringify(grant.player).includes('objectKey'));
  assert(!JSON.stringify(grant.player).includes(pointer.digest));
  assert.deepEqual(grant.checks.filter(action => action.ConditionCheck?.Key?.sk.S === 'PRESENTATION')
    .map(action => action.ConditionCheck!.Key!.pk.S), ['PLAYER#target']);
  client.seed('PLAYER#target', 'PRESENTATION', 'playerPresentation', { ...present, portrait: null });
  await assert.rejects(access.assertCurrent(grant.checks), error => (error as any).code === 'player_profile_changed');
  assert.equal((await access.authorize({ ...caller, playerId: 'target', viewerPlayerId: 'owner' })).player.hasPortrait, false);
});

test('portrait pointer scope corruption fails closed and discovery does not add media checks', async () => {
  const { client, access, caller } = fixture();
  client.seed('PLAYER#owner', 'PRESENTATION', 'playerPresentation', { version: 1, playerId: 'other', nameRevision: '11111111-1111-4111-8111-111111111111' });
  await assert.rejects(access.authorize({ ...caller, playerId: 'owner' }));
  const page = await access.discover(caller); assert.deepEqual(page.players.map(player => player.playerId), ['owner']);
  assert(client.transactions.at(-1)!.every(action => action.ConditionCheck?.Key?.sk.S !== 'PRESENTATION'));
});

// Context-free navigation uses the same fixtures/access authority, but its
// bounded claim/league discovery can issue direct consistent point reads.
async function myProfilesFixture() {
  const f = fixture(), send = f.client.send.bind(f.client);
  f.client.send = async command => {
    if (command instanceof GetItemCommand) {
      assert.equal(command.input.ConsistentRead, true);
      return { Item: structuredClone(f.client.items.get(itemKey(command.input.Key!))) };
    }
    return send(command);
  };
  const { MyPlayerProfiles } = await import('../data/my-player-profiles.js');
  const service = new MyPlayerProfiles(f.client, 'table');
  const all = async (caller = f.caller) => {
    const result: Array<{ playerId: string; displayName: string; leagueId: string; leagueName: string }> = [];
    let cursor: string | undefined;
    for (let step = 0; step < 40; step++) {
      const page = await service.list({ ...caller, cursor }); result.push(...page.profiles);
      assert.equal(page.complete, page.cursor === null);
      if (!page.cursor) return result;
      cursor = page.cursor;
    }
    assert.fail('profile discovery must terminate');
  };
  return { ...f, service, all };
}

test('own profile discovery follows both account namespaces and lists only current canonical league links', async () => {
  const f = await myProfilesFixture();
  addAliases(f.client, 'owner', ['alias']);
  f.client.seed(`USER#${email}`, playerClaimSk('alias'), 'playerClaim', { playerId: 'alias', userId: email });
  addPlayer(f.client, 'unclaimed', null);
  f.client.seed(`USER#${account}`, playerClaimSk('unclaimed'), 'playerClaim', { playerId: 'unclaimed', userId: account });
  addPlayer(f.client, 'email-player', email);
  const result = await f.all();
  assert.deepEqual(result.map(row => row.playerId).sort(), ['email-player', 'owner']);
  assert(result.every(row => row.leagueId === 'league' && row.leagueName === 'Test league'));
  assert(!JSON.stringify(result).includes('@'));
  assert(f.client.queries.every(query => query.Limit! <= 5));
});

test('own profile discovery continues bounded league pages and skips inactive/deleted membership', async () => {
  const f = await myProfilesFixture();
  for (let index = 0; index < 7; index++) {
    const leagueId = `league-${index}`;
    f.client.seed(`LEAGUE#${leagueId}`, 'METADATA', 'league', { leagueId, name: leagueId });
    f.client.seed('PLAYER#owner', identityLeagueSk(leagueId), 'playerLeagueMembership', { playerId: 'owner', leagueId });
    f.client.seed(`LEAGUE#${leagueId}`, identityDirectorySk('owner'), 'leaguePlayer', { playerId: 'owner', active: index !== 5, nickname: 'Owner' });
    if (index === 6) f.client.seed('PLAYER_IDENTITY_TOMBSTONE', identityTombstoneSk('league', [leagueId]), 'playerIdentityTombstone', { leagueId });
  }
  const result = await f.all();
  assert.deepEqual(result.map(row => row.leagueId).sort(), ['league', 'league-0', 'league-1', 'league-2', 'league-3', 'league-4']);
  assert(f.client.queries.filter(query => query.ExpressionAttributeValues?.[':prefix'].S === 'LEAGUE#').length >= 2);
});

test('own profile cursors reject another account, changed claims and malformed continuations', async () => {
  const f = await myProfilesFixture(), first = await f.service.list(f.caller);
  assert(first.cursor);
  await assert.rejects(f.service.list({ userId: 'another', cursor: first.cursor }), /Start a new player search/);
  const state = JSON.parse(Buffer.from(first.cursor, 'base64url').toString('utf8'));
  state.pending = { playerId: 'target', claimKey: playerClaimSk('target'), leagueAfter: 'not-a-membership' };
  await assert.rejects(f.service.list({ ...f.caller, cursor: Buffer.from(JSON.stringify(state)).toString('base64url') }), /Start a new player search/);
  f.client.seed(`USER#${account}`, 'PLAYER_CLAIMS_REVISION', 'playerClaimsRevision', { revision: 'changed' });
  await assert.rejects(f.service.list({ ...f.caller, cursor: first.cursor }), /Start a new player search/);
});

test('own profile discovery never publishes a profile whose ownership changes during access verification', async () => {
  const f = await myProfilesFixture();
  f.client.beforeCommit = () => { claimRoot(f.client, 'owner', 'different-account'); };
  await assert.rejects(f.service.list(f.caller), /Player access changed/);
});

test('own profile discovery supports oversized claim identifiers and an empty account', async () => {
  const f = await myProfilesFixture(), id = 'x'.repeat(1100);
  addPlayer(f.client, id, email);
  assert((await f.all()).some(row => row.playerId === id));
  assert.deepEqual(await f.all({ ...f.caller, userId: 'nobody', userIds: ['nobody'] }), []);
});


test('own profile pagination follows DynamoDB UTF-8 ordering for opaque Unicode player IDs', async () => {
  const f = await myProfilesFixture();
  addPlayer(f.client, '\ue000', account);
  addPlayer(f.client, '\u{1f600}', account);
  const ids = (await f.all()).map(row => row.playerId);
  assert.deepEqual(ids, ['owner', '\ue000', '\u{1f600}']);
});

test('own profile discovery preserves an empty claim page continuation before advancing namespaces', async () => {
  const f = await myProfilesFixture();
  let empty = true;
  f.client.queryOverride = result => {
    if (empty) {
      empty = false;
      return { Items: [], LastEvaluatedKey: historyKey(`USER#${account}`, 'PLAYER#0') };
    }
    return result;
  };
  const first = await f.service.list(f.caller);
  assert.deepEqual(first.profiles, []); assert(first.cursor);
  const second = await f.service.list({ ...f.caller, cursor: first.cursor });
  assert.deepEqual(second.profiles.map(row => row.playerId), ['owner']);
  assert.deepEqual(f.client.queries[1].ExclusiveStartKey, historyKey(`USER#${account}`, 'PLAYER#0'));
});
