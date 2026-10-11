// Local HTTP parity with a loopback DynamoDB protocol fixture. No AWS credentials,
// existing data, email or containers are used. Run after the API build.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const database = createServer(async (request, response) => {
  for await (const _ of request) { /* consume SDK request */ }
  const get = request.headers['x-amz-target']?.endsWith('.GetItem');
  const body = get ? { Item: { pk: { S: 'AUTH_SESSION#synthetic' }, sk: { S: 'METADATA' },
    entityType: { S: 'session' }, email: { S: 'synthetic@example.invalid' }, subject: { S: 'synthetic' },
    createdAt: { S: new Date().toISOString() }, expiresAtEpoch: { N: String(Math.floor(Date.now() / 1000) + 3600) } } } : {};
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
  const url = `http://127.0.0.1:${startup.host.port}/v1/auth/session`;
  for (const [headers, expected] of [[{}, 401], [{ Cookie: 'session=synthetic' }, 200]]) {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
    await response.text(); assert.equal(response.status, expected);
  }
  for (let i = 0; completed.length < 2 && i < 50; i++) await delay(20);
  assert.equal(completed.length, 2, 'one completion record per request');
  assert.deepEqual(completed.map(entry => entry.status), [401, 200]);
  assert.deepEqual(completed.map(entry => entry.performance.dbCalls), [0, 1]);
  assert.ok(completed.every(entry => entry.performance.dbRetries === 0 && entry.performance.dbFailures === 0));
  assert.ok(completed.every(entry => Object.values(entry.performance).every(value => typeof value === 'number' && Number.isFinite(value))));
  assert.ok(!JSON.stringify(completed).includes('synthetic@example.invalid'));
  console.log('PASS local HTTP completion parity: early rejection and DB-backed session read');
} finally {
  worker.kill('SIGTERM'); const timer = setTimeout(() => worker.kill('SIGKILL'), 2000);
  try { await exited; } finally { clearTimeout(timer); database.closeAllConnections(); await new Promise(resolve => database.close(resolve)); }
  process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
}
