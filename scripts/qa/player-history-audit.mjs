#!/usr/bin/env node
// Offline QA operator only. No mutation commands; one bounded continuation per invocation.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { isAbsolute, resolve } from 'node:path';
import { DynamoDBClient, GetItemCommand, QueryCommand, ScanCommand, TransactGetItemsCommand } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';

export const QA = Object.freeze({ accountId: '301691475109', region: 'ap-southeast-2', tableName: '3fc-qa-app', profile: '3fc-agent' });
const text = z.string().min(1).max(2048).refine(value => Boolean(value.trim()));
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(name => [name, canonical(value[name])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const keySchema = z.object({ pk: z.object({ S: text }).strict(), sk: z.object({ S: z.string().min(1).max(1024) }).strict() }).strict();
const key = (pk, sk) => ({ pk: { S: pk }, sk: { S: sk } });
const fail = message => { throw new Error(message); };
const totalsSchema = z.object({ played: count, goals: count, assists: count, ownGoals: count, wins: count, draws: count, losses: count, goalsPerGame: z.number().nonnegative().finite() }).strict();
const zero = () => ({ played: 0, goals: 0, assists: 0, ownGoals: 0, wins: 0, draws: 0, losses: 0, goalsPerGame: 0 });
const fields = ['played', 'goals', 'assists', 'ownGoals', 'wins', 'draws', 'losses'];
const totals = value => {
  const result = totalsSchema.parse(value);
  if (result.wins + result.draws + result.losses !== result.played || result.goalsPerGame !== (result.played ? result.goals / result.played : 0)) fail('Inconsistent summary totals.');
  return result;
};
const add = (a, b) => totals(Object.fromEntries([...fields.map(field => [field, a[field] + b[field]]), ['goalsPerGame', (a.played + b.played) ? (a.goals + b.goals) / (a.played + b.played) : 0]]));
const equalTotals = (a, b) => fields.every(field => a[field] === b[field]) && a.goalsPerGame === b.goalsPerGame;
const appearanceSchema = z.object({ gameId: text, seasonId: text, kickoffAt: z.string().datetime({ offset: true }), finishedAt: z.string().datetime({ offset: true }),
  teamId: z.enum(['red', 'blue', 'yellow']), outcome: z.enum(['win', 'draw', 'loss']), goals: count, assists: count, ownGoals: count, scored: count, conceded: count }).strict();
const bindingSchema = z.object({ ...Object.fromEntries(Object.entries(QA).map(([name, value]) => [name, z.literal(value)])), head: z.string().regex(/^[a-f0-9]{40}$/), runId: z.string().regex(/^[1-9][0-9]*$/) }).strict();
const playerSchema = z.object({ id: text, publication: hash, context: hash, seasons: z.array(text).max(1000), scope: z.number().int().min(-1).max(999),
  cursor: z.string().min(1).max(8192).nullable(), accumulated: totalsSchema, career: totalsSchema.nullable(), seasonSum: totalsSchema,
  last: z.object({ gameId: text, kickoffAt: text }).strict().nullable() }).strict();
const stateSchema = z.discriminatedUnion('kind', [
  z.object({ version: z.literal(1), kind: z.literal('inventory'), binding: bindingSchema, after: keySchema.nullable(), scanned: count, live: count }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('audit'), binding: bindingSchema, leagueId: text, fence: hash,
    after: z.string().regex(/^PLAYER#[a-f0-9]{64}$/).nullable(), directoryDone: z.boolean(), checked: count,
    player: playerSchema.nullable() }).strict()
]);
export function encodeAuditCursor(state) {
  const cursor = Buffer.from(JSON.stringify(stateSchema.parse(state))).toString('base64url');
  if (cursor.length > 262144) fail('Audit continuation exceeds its explicit storage budget.');
  return cursor;
}
function decode(token, binding, kind) {
  if (!token) return null;
  if (token.length > 262144 || !/^[A-Za-z0-9_-]+$/.test(token)) fail('Invalid audit continuation.');
  const state = stateSchema.parse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
  if (state.kind !== kind || JSON.stringify(state.binding) !== JSON.stringify(binding)) fail('Audit continuation scope changed.');
  return state;
}
export function auditArguments(args) {
  const command = args[0], options = {};
  if (!['inventory', 'audit'].includes(command)) fail('Choose inventory or audit.');
  for (let index = 1; index < args.length; index += 2) {
    const name = args[index];
    if (!['--head', '--run-id', '--profile', '--league', '--cursor', '--state'].includes(name) || Object.hasOwn(options, name) || !args[index + 1]) fail('Unknown, duplicate or incomplete audit option.');
    options[name] = args[index + 1];
  }
  const binding = bindingSchema.parse({ ...QA, profile: options['--profile'], head: options['--head'], runId: options['--run-id'] });
  if (command === 'audit' ? !options['--league']?.trim() : options['--league'] !== undefined) fail('Only audit requires --league.');
  if (command === 'inventory' ? !options['--state'] || !isAbsolute(options['--state']) || options['--cursor'] !== undefined : options['--state'] !== undefined)
    fail('Inventory requires an absolute private --state file; only audit accepts --cursor.');
  if (options['--league']) text.parse(options['--league']);
  decode(options['--cursor'], binding, command);
  return { command, binding, leagueId: options['--league'], cursor: options['--cursor'], stateFile: options['--state'] };
}
const inventoryLimitation = 'Inventory is not a snapshot. Compare complete before/after inventories; league audits have separate revision fences.';
const privateStateSchema = z.object({ version: z.literal(1), binding: bindingSchema, complete: z.boolean(), cursor: z.string().min(1).max(262144).nullable(),
  leagueIds: z.array(text).max(10000), scanned: count, live: count }).strict()
  .refine(value => value.complete === (value.cursor === null) && value.live === value.leagueIds.length && new Set(value.leagueIds).size === value.leagueIds.length);
async function readPrivateState(path) {
  let stat;
  try { stat = await lstat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid() || stat.size > 300000) fail('Inventory state must be an owned regular 0600 file.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = await file.stat();
    if (actual.ino !== stat.ino || actual.dev !== stat.dev) fail('Inventory state changed.');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}
/** Scan continuation keys may contain live session tokens or emails. Never print them,
 * including base64 encoding. Persist only in an explicitly selected private file. */
export async function privateInventoryStep({ stateFile, binding, run, beforeSave = async () => {} }) {
  if (!isAbsolute(stateFile)) fail('Use an absolute inventory state path.');
  const previous = await readPrivateState(stateFile), saved = previous === null ? null : privateStateSchema.parse(JSON.parse(previous));
  if (saved && digest(saved.binding) !== digest(binding)) fail('Inventory state scope changed.');
  if (saved?.complete) {
    await beforeSave();
    return { status: 'complete', leagueIds: [], allLeagueIds: saved.leagueIds, scanned: saved.scanned, live: saved.live,
      limitation: inventoryLimitation, replayed: true };
  }
  const result = await run(saved?.cursor ?? undefined);
  const next = privateStateSchema.parse({ version: 1, binding, complete: result.status === 'complete', cursor: result.cursor,
    leagueIds: [...(saved?.leagueIds ?? []), ...result.leagueIds], scanned: result.scanned, live: result.live });
  const serialized = JSON.stringify(next);
  if (Buffer.byteLength(serialized) > 300000) fail('Inventory exceeds its explicit private-state budget.');
  await beforeSave();
  if (await readPrivateState(stateFile) !== previous) fail('Inventory state changed concurrently.');
  const temporary = previous === null ? stateFile : `${stateFile}.${randomUUID()}.tmp`;
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
  if (previous !== null) {
    try { await rename(temporary, stateFile); } catch (error) { await unlink(temporary); throw error; }
  }
  const { cursor: ignored, ...safe } = result;
  return { ...safe, ...(next.complete ? { allLeagueIds: next.leagueIds } : {}) };
}
async function get(client, pk, sk) {
  return (await client.send(new GetItemCommand({ TableName: QA.tableName, Key: key(pk, sk), ConsistentRead: true }))).Item ?? null;
}
function body(item, pk, sk, type) {
  if (item?.pk?.S !== pk || item?.sk?.S !== sk || item?.entityType?.S !== type || !item?.data?.S) fail('Malformed audit source record.');
  return JSON.parse(item.data.S);
}
const tombstoneKey = leagueId => `league#${digest([leagueId])}`;
async function deleted(client, leagueId) {
  const sk = tombstoneKey(leagueId), item = await get(client, 'PLAYER_IDENTITY_TOMBSTONE', sk);
  if (!item) return false;
  const value = body(item, 'PLAYER_IDENTITY_TOMBSTONE', sk, 'playerIdentityTombstone');
  if (value.kind !== 'league' || JSON.stringify(value.ids) !== JSON.stringify([leagueId])) fail('Malformed league deletion evidence.');
  return true;
}

/** Scans at most 100 raw keys, never source payloads. Scan is not a global snapshot:
 * compare completed inventories before/after the league audits, or use a fixed reviewed list. */
export async function inventoryPage({ client, binding: rawBinding, cursor }) {
  const binding = bindingSchema.parse(rawBinding), state = decode(cursor, binding, 'inventory') ?? { version: 1, kind: 'inventory', binding, after: null, scanned: 0, live: 0 };
  const page = await client.send(new ScanCommand({ TableName: QA.tableName, ConsistentRead: true, Limit: 100,
    ProjectionExpression: 'pk, sk, entityType', FilterExpression: 'entityType = :type AND sk = :metadata',
    ExpressionAttributeValues: { ':type': { S: 'league' }, ':metadata': { S: 'METADATA' } }, ...(state.after ? { ExclusiveStartKey: state.after } : {}) }));
  if (!Array.isArray(page.Items ?? []) || (page.Items ?? []).length > 100 || !Number.isSafeInteger(page.ScannedCount) || page.ScannedCount < (page.Items ?? []).length || page.ScannedCount > 100) fail('Malformed inventory page.');
  const leagueIds = [], seen = new Set();
  for (const item of page.Items ?? []) {
    if (!item.pk?.S?.startsWith('LEAGUE#') || item.sk?.S !== 'METADATA' || item.entityType?.S !== 'league') fail('Unexpected inventory row.');
    const leagueId = text.parse(item.pk.S.slice(7));
    if (seen.has(leagueId)) fail('Duplicate inventory league.');
    seen.add(leagueId);
    if (await deleted(client, leagueId)) continue;
    const live = await get(client, item.pk.S, 'METADATA');
    if (!live || body(live, item.pk.S, 'METADATA', 'league').leagueId !== leagueId) fail('Inventory changed; restart the pass.');
    if (await deleted(client, leagueId)) fail('Inventory changed; restart the pass.');
    leagueIds.push(leagueId);
  }
  const after = page.LastEvaluatedKey && Object.keys(page.LastEvaluatedKey).length ? keySchema.parse(page.LastEvaluatedKey) : null;
  if (after && JSON.stringify(after) === JSON.stringify(state.after)) fail('Inventory continuation did not advance.');
  const next = { ...state, after, scanned: state.scanned + page.ScannedCount, live: state.live + leagueIds.length };
  return { status: after ? 'partial' : 'complete', leagueIds, scanned: next.scanned, live: next.live,
    limitation: inventoryLimitation, cursor: after ? encodeAuditCursor(next) : null };
}

async function leagueFence(client, runtime, leagueId) {
  const pk = `LEAGUE#${leagueId}`, pairs = [[pk, 'METADATA'], [pk, 'HISTORY_SOURCE'], [pk, 'PLAYER_DIRECTORY'], [pk, 'HISTORY_SWEEP'],
    [pk, 'PROFILE_SEASON_DEFAULT'], ['PLAYER_HISTORY', 'CONTROL'], ['PLAYER_IDENTITY', 'CONTROL'], ['PLAYER_IDENTITY_TOMBSTONE', tombstoneKey(leagueId)]];
  const read = async () => (await client.send(new TransactGetItemsCommand({ TransactItems: pairs.map(([a, b]) => ({ Get: { TableName: QA.tableName, Key: key(a, b) } })) }))).Responses?.map(value => value.Item ?? null);
  const rows = await read();
  if (!rows || rows.length !== pairs.length || rows[7]) fail('League coverage unavailable or deleted.');
  const league = body(rows[0], pk, 'METADATA', 'league'), source = body(rows[1], pk, 'HISTORY_SOURCE', 'playerHistorySource');
  const directory = rows[2] ? body(rows[2], pk, 'PLAYER_DIRECTORY', 'playerDirectoryRevision') : null;
  const sweep = body(rows[3], pk, 'HISTORY_SWEEP', 'playerHistorySweep');
  const fallback = runtime.profileSeasonDefaultSchema.parse(body(rows[4], pk, 'PROFILE_SEASON_DEFAULT', 'playerProfileSeasonDefault'));
  const ready = await runtime.readiness(), control = await runtime.control();
  if (JSON.stringify(ready.item) !== JSON.stringify(rows[5]) || JSON.stringify(control.item) !== JSON.stringify(rows[6])) fail('League changed during audit.');
  if (league.leagueId !== leagueId || source.version !== 1 || source.leagueId !== leagueId || !source.revision || (directory && typeof directory.revision !== 'string')
    || sweep.version !== 1 || sweep.leagueId !== leagueId || sweep.phase !== 'complete' || !sweep.completedAt || sweep.cursor !== null || sweep.seasonCatalogueVersion !== 1
    || sweep.revision !== source.revision || sweep.readinessRevision !== ready.value.revision || sweep.directoryData !== (rows[2]?.data?.S ?? null)
    || !Number.isSafeInteger(sweep.checked) || sweep.checked < 0 || sweep.checked !== sweep.enqueued
    || fallback.leagueId !== leagueId || fallback.sourceRevision !== source.revision || fallback.readinessRevision !== ready.value.revision) fail('League projection coverage is not current and complete.');
  if (digest(await read()) !== digest(rows)) fail('League changed during audit.');
  return { fingerprint: digest(rows), revision: source.revision, readinessRevision: ready.value.revision, expected: sweep.checked };
}
function contextFingerprint(context) { return digest(context); }
async function currentPlayer(runtime, leagueId, playerId, fence) {
  const context = await runtime.source.captureContext(leagueId, playerId), publication = await runtime.store.getPublication(leagueId, playerId);
  if (context.playerId !== playerId || context.sourceRevision !== fence.revision || context.readinessRevision !== fence.readinessRevision
    || !runtime.publicationCurrent(publication, fence.revision, fence.readinessRevision)) fail('Player publication is not current.');
  if (publication.leagueId !== leagueId || publication.playerId !== playerId || !Array.isArray(publication.seasons) || publication.seasons.length > 1000) fail('Malformed publication scope.');
  const seasons = publication.seasons.map(value => text.parse(value.seasonId));
  if (new Set(seasons).size !== seasons.length) fail('Duplicate publication season.');
  return { context: contextFingerprint(context), publication: digest(publication), seasons, latest: publication.latest };
}

/** Checks derived consistency, not an independent raw-event/achievement oracle.
 * Every step is read-only and bounded: one directory row or <=20 appearances. */
export async function auditLeaguePage({ client, runtime, binding: rawBinding, leagueId, cursor }) {
  const binding = bindingSchema.parse(rawBinding); text.parse(leagueId);
  const fence = await leagueFence(client, runtime, leagueId);
  let state = decode(cursor, binding, 'audit') ?? { version: 1, kind: 'audit', binding, leagueId, fence: fence.fingerprint, after: null, directoryDone: false, checked: 0, player: null };
  if (state.leagueId !== leagueId || state.fence !== fence.fingerprint) fail('Audit source changed; restart this league.');
  if (!state.player && !state.directoryDone) {
    const pk = `LEAGUE#${leagueId}`;
    const page = await client.send(new QueryCommand({ TableName: QA.tableName, ConsistentRead: true, Limit: 1,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)', ExpressionAttributeValues: { ':pk': { S: pk }, ':prefix': { S: 'PLAYER#' } },
      ...(state.after ? { ExclusiveStartKey: key(pk, state.after) } : {}) }));
    if (!Array.isArray(page.Items ?? []) || (page.Items ?? []).length > 1) fail('Malformed directory page.');
    const row = page.Items?.[0], afterKey = page.LastEvaluatedKey && Object.keys(page.LastEvaluatedKey).length ? keySchema.parse(page.LastEvaluatedKey) : null;
    if (row && state.after && row.sk?.S <= state.after) fail('Directory row did not advance.');
    if (afterKey && (afterKey.pk.S !== pk || !/^PLAYER#[a-f0-9]{64}$/.test(afterKey.sk.S) || afterKey.sk.S !== row?.sk?.S || (state.after && afterKey.sk.S <= state.after))) fail('Invalid directory continuation.');
    state = { ...state, after: afterKey?.sk.S ?? null, directoryDone: !afterKey };
    if (row) {
      const entry = body(row, pk, row.sk?.S, 'leaguePlayer');
      if (typeof entry.active !== 'boolean' || row.sk?.S !== runtime.identityDirectorySk(text.parse(entry.playerId))) fail('Malformed directory player.');
      if (entry.active) {
        const current = await currentPlayer(runtime, leagueId, entry.playerId, fence);
        state.player = { id: entry.playerId, context: current.context, publication: current.publication, seasons: current.seasons,
          scope: -1, cursor: null, accumulated: zero(), career: null, seasonSum: zero(), last: null };
      }
    }
  } else if (state.player) {
    const player = state.player, current = await currentPlayer(runtime, leagueId, player.id, fence);
    if (player.context !== current.context || player.publication !== current.publication || JSON.stringify(player.seasons) !== JSON.stringify(current.seasons)) fail('Player changed; restart this league.');
    if (player.scope >= player.seasons.length) fail('Invalid audit scope continuation.');
    const seasonId = player.scope < 0 ? undefined : player.seasons[player.scope];
    const scope = seasonId === undefined ? { scope: 'career', seasonId: null } : { scope: 'season', seasonId };
    const summary = await runtime.store.getSummary(leagueId, player.id, scope);
    if (!summary) fail('Required published summary is missing.');
    const expected = totals(summary.state.totals);
    if (expected.played && (!summary.state.context || summary.state.context.leagueId !== leagueId || summary.state.context.playerId !== player.id)) fail('Summary context is missing or inconsistent.');
    const page = await runtime.store.pageMatches({ leagueId, playerId: player.id, ...(seasonId === undefined ? {} : { seasonId }), ...(player.cursor ? { cursor: player.cursor } : {}), limit: 20 });
    if (!page || !Array.isArray(page.items) || page.items.length > 20 || (page.cursor !== null && (typeof page.cursor !== 'string' || !page.cursor || page.cursor === player.cursor))) fail('Invalid appearance continuation.');
    for (const raw of page.items) {
      const appearance = appearanceSchema.parse(raw);
      if ((seasonId !== undefined && appearance.seasonId !== seasonId) || !player.seasons.includes(appearance.seasonId)) fail('Appearance season is outside publication coverage.');
      if (player.last && runtime.matchOrderKey(appearance) >= runtime.matchOrderKey(player.last)) fail('Appearance order or identity is duplicated.');
      if (player.scope < 0 && player.accumulated.played === 0 && digest(appearance) !== digest(current.latest)) fail('Latest appearance does not match publication.');
      player.last = { gameId: appearance.gameId, kickoffAt: appearance.kickoffAt };
      player.accumulated = add(player.accumulated, { played: 1, goals: appearance.goals, assists: appearance.assists, ownGoals: appearance.ownGoals,
        wins: Number(appearance.outcome === 'win'), draws: Number(appearance.outcome === 'draw'), losses: Number(appearance.outcome === 'loss'), goalsPerGame: appearance.goals });
    }
    if (page.cursor) player.cursor = page.cursor;
    else {
      if (!equalTotals(expected, player.accumulated)) fail('Appearance totals differ from published summary.');
      if (player.scope < 0) {
        if ((expected.played === 0) !== (current.latest === null) || (expected.played === 0 && player.seasons.length)) fail('Zero-appearance publication is inconsistent.');
        player.career = expected;
      } else { if (!expected.played) fail('Published played season has no appearances.'); player.seasonSum = add(player.seasonSum, expected); }
      player.scope++; player.cursor = null; player.accumulated = zero(); player.last = null;
      if (player.scope === player.seasons.length) {
        if (!equalTotals(player.career, player.seasonSum)) fail('Season totals differ from career totals.');
        state.checked++; state.player = null;
      }
    }
    const finalPlayer = await currentPlayer(runtime, leagueId, player.id, fence);
    if (finalPlayer.context !== player.context || finalPlayer.publication !== player.publication) fail('Player changed during audit.');
  }
  if ((await leagueFence(client, runtime, leagueId)).fingerprint !== state.fence) fail('League changed during audit.');
  const complete = state.directoryDone && !state.player;
  if (complete && state.checked !== fence.expected) fail('Directory player coverage differs from completed sweep.');
  return { status: complete ? 'complete' : 'partial', checkedPlayers: state.checked, expectedPlayers: fence.expected,
    evidence: 'Current publication coverage and career/season/appearance consistency; not an independent raw-event or achievement oracle.',
    cursor: complete ? null : encodeAuditCursor(state) };
}

async function main(args) {
  const input = auditArguments(args);
  const { verifyQaProvenance, assertQaProfileReadiness } = await import('./player-profile-provenance.mjs');
  const provenance = await verifyQaProvenance({ head: input.binding.head, runId: input.binding.runId, requireFeatures: false });
  // Import only after provenance helper's forced build. Explicit profile ignores ambient credentials.
  const client = new DynamoDBClient({ region: QA.region, profile: input.binding.profile });
  try {
    let result;
    if (input.command === 'inventory') result = await privateInventoryStep({ stateFile: input.stateFile, binding: input.binding,
      run: cursor => inventoryPage({ client, binding: input.binding, cursor }), beforeSave: () => provenance.recheck() });
    else {
      const [{ HistorySource }, { PlayerHistoryStore }, identity, readiness, coordinator, season, facts] = await Promise.all([
        import('../../api/dist/data/player-history-source.js'), import('../../api/dist/data/player-history-store.js'),
        import('../../api/dist/data/player-identity.js'), import('../../api/dist/data/player-history-readiness.js'),
        import('../../api/dist/data/player-history-coordinator.js'), import('../../api/dist/data/player-profile-season.js'), import('../../api/dist/achievements/facts.js')]);
      const planner = new identity.PlayerIdentityPlanner(client, QA.tableName);
      const runtime = { source: new HistorySource(client, QA.tableName), store: new PlayerHistoryStore(client, QA.tableName),
        identityDirectorySk: identity.identityDirectorySk, publicationCurrent: coordinator.publicationCurrent,
        profileSeasonDefaultSchema: season.profileSeasonDefaultSchema, matchOrderKey: facts.matchOrderKey,
        readiness: async () => { const ready = await readiness.readHistoryReadiness(client, QA.tableName); assertQaProfileReadiness(ready.value, input.binding.head); return ready; },
        control: async () => { const control = await planner.readControl(); planner.requireDirectory(control); return control; } };
      result = await auditLeaguePage({ client, runtime, ...input });
    }
    // Report success only if the accepted deployment still matches after these reads.
    if (input.command !== 'inventory') await provenance.recheck();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally { client.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(() => {
  process.stderr.write('QA history audit failed; no completion evidence was emitted. Inspect the reviewed source and restart changed scopes.\n'); process.exitCode = 1;
});
