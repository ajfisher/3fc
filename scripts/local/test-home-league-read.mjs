// Local HTTP parity with a loopback DynamoDB protocol fixture. No AWS credentials,
// existing data, email or containers are used. Run after the API build.
import assert from 'node:assert/strict';
import { homeAccountPk, homeLeagueSk } from '../../api/dist/data/home-league-lookup.js';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const envelope = (pk, sk, entityType, data) => ({ pk: { S: pk }, sk: { S: sk }, entityType: { S: entityType }, data: { S: JSON.stringify(data) },
  createdAt: { S: '2026-10-08T00:00:00Z' }, updatedAt: { S: '2026-10-08T00:00:00Z' } });
const coverage = envelope('HOME_LOOKUP', 'CONTROL', 'homeLeagueCoverage', { version: 1, epoch: 'local-coverage', phase: 'ready', cursor: null, pages: 2, repaired: 1, verified: 1,
  manifest: { migrationId: 'home-smoke-local', accountId: '123456789012', region: 'ap-southeast-2', tableName: 'synthetic-performance',
    tableArn: 'arn:aws:dynamodb:ap-southeast-2:123456789012:table/synthetic-performance', writerSha: 'a'.repeat(40), writerVersion: 1,
    reviewedPlan: 'https://github.com/ajfisher/3fc/pull/234', drainedAt: '2026-10-08T00:00:00Z' } });
const pointer = envelope(homeAccountPk('synthetic'), homeLeagueSk('local-league'), 'homeLeagueLookup', { version: 1, leagueId: 'local-league' });
const rows = [coverage, envelope('HOME_LOOKUP', 'READER', 'homeLeagueReader', { version: 1, enabled: true, coverageEpoch: 'local-coverage' }),
  envelope('LEAGUE#local-league', 'METADATA', 'league', { leagueId: 'local-league', name: 'Local League', slug: null, createdByUserId: 'private@example.invalid' }),
  envelope('LEAGUE#local-league', 'ACL#USER#synthetic', 'acl', { leagueId: 'local-league', userId: 'synthetic', role: 'admin', grantedByUserId: 'synthetic' })];
let revoked = false;
const lookup = key => rows.find(row => row.pk.S === key.pk.S && row.sk.S === key.sk.S && !(revoked && row.entityType.S === 'acl'));
const database = createServer(async (request, response) => {
  let raw = ''; for await (const chunk of request) raw += chunk;
  const input = JSON.parse(raw || '{}'), operation = request.headers['x-amz-target']?.split('.').at(-1);
  let body = {};
  if (operation === 'GetItem') {
    body = input.Key.pk.S.startsWith('AUTH_SESSION#') ? { Item: { pk: { S: 'AUTH_SESSION#synthetic' }, sk: { S: 'METADATA' },
      entityType: { S: 'session' }, email: { S: 'synthetic@example.invalid' }, subject: { S: 'synthetic' },
      createdAt: { S: new Date().toISOString() }, expiresAtEpoch: { N: String(Math.floor(Date.now() / 1000) + 3600) } } }
      : { Item: lookup(input.Key) };
  } else if (operation === 'Query') body = { Items: input.ExpressionAttributeValues[':pk'].S === pointer.pk.S ? [pointer] : [] };
  else if (operation === 'TransactGetItems') body = { Responses: input.TransactItems.map(row => ({ Item: lookup(row.Get.Key) })) };
  response.writeHead(200, { 'content-type': 'application/x-amz-json-1.0' }); response.end(JSON.stringify(body));
});
database.listen(0, '127.0.0.1'); await once(database, 'listening');
const worker = spawn(process.execPath, ['api/dist/server.js'], { env: { ...process.env,
  PORT: '0', THREEFC_LISTEN_HOST: '127.0.0.1', DYNAMODB_ENDPOINT: `http://127.0.0.1:${database.address().port}`,
  DYNAMODB_TABLE: 'synthetic-performance', AWS_ACCESS_KEY_ID: 'local', AWS_SECRET_ACCESS_KEY: 'local',
  AWS_SESSION_TOKEN: '', AWS_REGION: 'ap-southeast-2', SESSION_COOKIE_NAME: 'session',
}, stdio: ['ignore', 'pipe', 'pipe'] });
const exited = once(worker, 'exit');
let pending = '', startup, failure = false;
const completed = [];
worker.stdout.on('data', bytes => {
  pending += bytes.toString();
  const lines = pending.split('\n'); pending = lines.pop();
  for (const line of lines) {
    try { const entry = JSON.parse(line); if (entry.message === 'API local server started') startup = entry;
      if (entry.message === 'request_complete') completed.push(entry); } catch { /* ignore non-JSON diagnostics */ }
  }
});
worker.stderr.on('data', () => { failure = true; });
const stop = () => { worker.kill('SIGKILL'); database.closeAllConnections(); database.close(); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
try {
  for (let i = 0; !startup && i < 100; i++) {
    assert.equal(worker.exitCode, null, 'local API must stay running'); await delay(50);
  }
  assert.ok(startup && !failure, 'local API starts against synthetic protocol fixture');
  const url = `http://127.0.0.1:${startup.host.port}/v1/leagues?page=1`;
  const headers = { Cookie: 'session=synthetic' };
  const first = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
  assert.equal(first.status, 200); assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await first.json(), { leagues: [{ leagueId: 'local-league', name: 'Local League', slug: null }], hasManagementAccess: true, complete: true, cursor: null });
  revoked = true;
  const second = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { leagues: [], hasManagementAccess: false, complete: true, cursor: null });
  for (let i = 0; completed.length < 2 && i < 50; i++) await delay(20);
  assert.equal(completed.length, 2);
  assert.deepEqual(completed.map(row => row.performance.dbCalls), [5, 5]);
  assert.ok(completed.every(row => row.performance.dbRetries === 0 && row.performance.dbFailures === 0));
  assert.ok(!JSON.stringify(completed).includes('private@example.invalid'));
  console.log('PASS local HTTP home parity: paged read, current ACL revocation and five bounded SDK calls');

} finally {
  worker.kill('SIGTERM'); const timer = setTimeout(() => worker.kill('SIGKILL'), 2000);
  try { await exited; } finally { clearTimeout(timer); database.closeAllConnections(); await new Promise(resolve => database.close(resolve)); }
  process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
}
