import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handleOwnerPlayerProfileRoute, parseOwnerProfileBody, type OwnerPlayerProfileRepository } from '../owner-player-profile-routes.js';
import { handleLocalOwnerPlayerProfileRoute } from '../server.js';
import { PlayerIdentityError } from '../data/player-identity.js';
const session = { sessionId: 'session', subject: 'account', email: 'private@example.test', createdAt: '2026-10-03T00:00:00Z', expiresAt: '2026-10-11T00:00:00Z' };
const revision = 'a'.repeat(64);
const details = { playerId: 'canonical', displayName: 'Player', hasPortrait: false, revision };
const rename = { displayName: 'New name', expectedRevision: revision };
function fixture() {
  const calls: Array<{ method: string; input: any }> = [];
  const repository: OwnerPlayerProfileRepository = {
    async getOwnerPlayerProfile(input) { calls.push({ method: 'read', input }); return details; },
    async renameOwnerPlayerProfile(input) { calls.push({ method: 'rename', input }); return { ...details, displayName: input.displayName }; }
  };
  const request = (overrides: any = {}) => handleOwnerPlayerProfileRoute({ method: 'GET', route: '/v1/owner-player-profile',
    rawQueryString: 'playerId=alias%2F%252F', session, repository, enabled: true, ...overrides });
  return { calls, repository, request };
}
test('owner GET adds only verified session email after the canonical ownership read; rename stays safe', async () => {
  const { request, calls } = fixture();
  assert.deepEqual((await request()).payload, { ...details, email: session.email });
  const saved = await request({ method: 'PATCH', body: { ...rename, displayName: '  New name  ' }, idempotencyKey: 'save:1' });
  assert.equal(saved.statusCode, 200); assert.deepEqual(saved.payload, { ...details, displayName: 'New name' });
  assert.deepEqual(calls[0].input, { playerId: 'alias/%2F', userId: 'account', userIds: ['account', session.email] });
  assert.deepEqual(calls[1].input, { ...calls[0].input, ...rename, idempotencyKey: 'save:1' });
  assert(!Object.hasOwn(calls[1].input, 'email')); assert(!JSON.stringify(saved).includes(session.email));
});
test('anonymous, disabled, unknown or malformed queries never invoke owner service', async () => {
  const { request, calls } = fixture();
  assert.equal((await request({ session: null })).statusCode, 401);
  assert.equal((await request({ enabled: false })).statusCode, 404);
  assert.equal((await request({ method: 'POST' })).statusCode, 404);
  for (const rawQueryString of ['', 'playerId=', 'playerId=a&playerId=b', 'playerId=a&leagueId=l', 'playerId=a&owner=true',
    'playerId=a&userId=attacker', 'playerId=%ZZ', 'playerId=%ED%A0%80', 'playerId=a&'])
    assert.equal((await request({ rawQueryString })).statusCode, 400, rawQueryString);
  assert.deepEqual(calls, []);
});
test('rename rejects unsafe names, unknown fields, bad revisions and joined or duplicate idempotency values', async () => {
  const { request, calls } = fixture();
  const patch = { method: 'PATCH', body: rename, idempotencyKey: 'save' };
  for (const displayName of ['', '   ', 'x'.repeat(81), 'bad\nname', 'bad\u0085name', 'bad\ud800'])
    assert.equal((await request({ ...patch, body: { ...rename, displayName } })).statusCode, 400);
  for (const body of [null, [], { ...rename, email: session.email }, { ...rename, owner: true }, { ...rename, expectedRevision: '' }])
    assert.equal((await request({ ...patch, body })).statusCode, 400);
  for (const idempotencyKey of [undefined, '', ' key ', 'one,two', ['one', 'two'], 'x'.repeat(129), 'key/other'])
    assert.equal((await request({ ...patch, idempotencyKey })).statusCode, 400);
  assert.deepEqual(calls, []);
});
test('private storage payloads and errors fail closed; owner denial and conflict retain stable shapes', async () => {
  const { repository, request } = fixture();
  repository.getOwnerPlayerProfile = async () => ({ ...details, email: 'other@example.test' }) as any;
  assert.equal((await request()).statusCode, 503);
  repository.renameOwnerPlayerProfile = async () => ({ ...details, checks: [{ email: session.email }] }) as any;
  const bad = await request({ method: 'PATCH', body: rename, idempotencyKey: 'safe' });
  assert.equal(bad.statusCode, 503); assert(!JSON.stringify(bad).includes(session.email));
  repository.getOwnerPlayerProfile = async () => { throw new Error(`private ${session.email}`); };
  assert(!JSON.stringify(await request()).includes(session.email));
  for (const status of [403, 409, 503] as const) {
    repository.getOwnerPlayerProfile = async () => { throw new PlayerIdentityError('owner_profile_changed', status, 'Refresh and retry.'); };
    assert.equal((await request()).statusCode, status);
  }
});
test('owner body limit is bytes rather than character count', () => {
  assert.deepEqual(parseOwnerProfileBody(JSON.stringify(rename)), rename);
  assert.throws(() => parseOwnerProfileBody('"' + 'é'.repeat(4096) + '"'), RangeError);
  assert.throws(() => parseOwnerProfileBody('{'), SyntaxError);
});
test('local owner adapter provides private headers, bounded chunked bodies and duplicate header rejection', async () => {
  const { repository, calls } = fixture(); const previous = process.env.PLAYER_OWNER_EDITING_ENABLED;
  process.env.PLAYER_OWNER_EDITING_ENABLED = 'true';
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    void handleLocalOwnerPlayerProfileRoute({ request: req, response: res, method: req.method!, route: url.pathname,
      rawQueryString: url.search.slice(1), session: req.headers.cookie === 'session=valid' ? session : null, playerRepository: repository })
      .catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/owner-player-profile?playerId=alias`;
  try {
    const signed = { cookie: 'session=valid', 'idempotency-key': 'save1', 'content-type': 'application/json' };
    for (const loggedIn of [false, true]) {
      const response = await fetch(url, { headers: loggedIn ? signed : {} });
      assert.equal(response.status, loggedIn ? 200 : 401); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(JSON.stringify(await response.json()).includes(session.email), loggedIn);
    }
    const saved = await fetch(url, { method: 'PATCH', headers: signed, body: JSON.stringify(rename) });
    assert.equal(saved.status, 200); assert(!(await saved.text()).includes(session.email));
    const before = calls.length;
    for (const body of ['{', JSON.stringify({ ...rename, displayName: 'é'.repeat(5000) })]) {
      const response = await fetch(url, { method: 'PATCH', headers: signed, body });
      assert.equal(response.status, body === '{' ? 400 : 413); assert.equal(response.headers.get('cache-control'), 'no-store');
      await response.text();
    }
    const sendChunks = (duplicate: boolean) => new Promise<number>((resolve, reject) => {
      const req = httpRequest(url, { method: 'PATCH', headers: duplicate
        ? ['Cookie', 'session=valid', 'Idempotency-Key', 'one', 'idempotency-key', 'two', 'Content-Type', 'application/json'] : signed }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode!));
      }); req.on('error', reject);
      if (duplicate) req.end(JSON.stringify(rename));
      else { req.write('"' + 'x'.repeat(4096)); req.end('x'.repeat(4096) + '"'); }
    });
    assert.equal(await sendChunks(false), 413); assert.equal(await sendChunks(true), 400);
    assert.equal(calls.length, before, 'invalid bodies and duplicate keys never reach mutation service');
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (previous === undefined) delete process.env.PLAYER_OWNER_EDITING_ENABLED; else process.env.PLAYER_OWNER_EDITING_ENABLED = previous;
  }
});
