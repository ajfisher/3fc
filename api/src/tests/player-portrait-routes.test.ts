import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { handlePlayerPortraitRoute, parsePortraitBody, PORTRAIT_JSON_BODY_LIMIT, type PlayerPortraitRepository } from '../player-portrait-routes.js';
import { handleLocalPlayerPortraitRoute } from '../server.js';
import { PlayerIdentityError } from '../data/player-identity.js';
import { PortraitInputError } from '../media/player-portrait.js';
const session = { sessionId: 'session', subject: 'account', email: 'private@example.test', createdAt: '2026-10-03T00:00:00Z', expiresAt: '2026-10-11T00:00:00Z' };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6V0AAAAASUVORK5CYII=', 'base64');
const revision = 'a'.repeat(64), details = { playerId: 'canonical', displayName: 'Player', hasPortrait: true, revision };
const upload = { expectedRevision: revision, contentType: 'image/png', base64: png.toString('base64') };
const query = 'leagueId=league%2F%23&playerId=alias%2F%252F&viewerPlayerId=owned';
function fixture() {
  const calls: Array<{ method: string; input: any }> = [];
  const repository: PlayerPortraitRepository = {
    async getPlayerPortrait(input) { calls.push({ method: 'read', input }); return png; },
    async putOwnerPlayerPortrait(input) { calls.push({ method: 'upload', input }); return details; },
    async removeOwnerPlayerPortrait(input) { calls.push({ method: 'remove', input }); return { ...details, hasPortrait: false }; }
  };
  const request = (overrides: any = {}) => handlePlayerPortraitRoute({ method: 'GET', route: '/v1/player-portrait', rawQueryString: query,
    session, repository, flags: { profiles: true, ownerEditing: true }, ...overrides });
  const mutation = { method: 'PUT', route: '/v1/owner-player-portrait', rawQueryString: 'playerId=alias%2F%252F', body: upload, idempotencyKey: 'portrait:1' };
  return { repository, calls, request, mutation };
}
test('portrait GET preserves binary PNG and trusted league/account context; mutation DTO omits private data', async () => {
  const { calls, request, mutation } = fixture();
  const read = await request(); assert.equal(read.kind, 'portrait'); if (read.kind === 'portrait') assert.deepEqual(read.bytes, png);
  assert.deepEqual(calls[0].input, { leagueId: 'league/#', playerId: 'alias/%2F', viewerPlayerId: 'owned', userId: 'account', userIds: ['account', session.email] });
  const saved = await request(mutation); assert.deepEqual(saved, { kind: 'json', statusCode: 200, payload: details });
  assert.deepEqual(calls[1].input.bytes, png); assert.equal(calls[1].input.playerId, 'alias/%2F');
  assert(!Object.hasOwn(calls[1].input, 'base64')); assert(!Object.hasOwn(calls[1].input, 'email'));
  const removed = await request({ ...mutation, method: 'DELETE', body: { expectedRevision: revision } });
  assert.deepEqual(removed, { kind: 'json', statusCode: 200, payload: { ...details, hasPortrait: false } });
  assert(!JSON.stringify(saved).includes(session.email));
});
test('portrait read visibility stays independent from owner editing, and anonymous/disabled calls do not reach services', async () => {
  const { request, calls, mutation } = fixture();
  assert.equal((await request({ session: null })).statusCode, 401);
  assert.equal((await request({ flags: { profiles: false, ownerEditing: true } })).statusCode, 404);
  assert.equal((await request({ ...mutation, flags: { profiles: true, ownerEditing: false } })).statusCode, 404);
  assert.equal(calls.length, 0);
  assert.equal((await request({ flags: { profiles: true, ownerEditing: false } })).statusCode, 200);
  assert.equal((await request({ ...mutation, flags: { profiles: false, ownerEditing: true } })).statusCode, 200);
});
test('portrait routes reject scope hints, duplicate fields, invalid types, noncanonical base64 and oversized decoded input', async () => {
  const { request, calls, mutation } = fixture();
  for (const rawQueryString of ['', 'playerId=a', `${query}&owner=true`, `${query}&playerId=duplicate`, 'leagueId=l&playerId=%ED%A0%80'])
    assert.equal((await request({ rawQueryString })).statusCode, 400);
  for (const rawQueryString of ['playerId=a&leagueId=l', 'playerId=a&userId=attacker', 'playerId=a&viewerPlayerId=v'])
    assert.equal((await request({ ...mutation, rawQueryString })).statusCode, 400);
  for (const body of [{ ...upload, objectKey: 'other-object' }, { ...upload, contentType: 'image/svg+xml' },
    { ...upload, expectedRevision: '' }, { ...upload, base64: 'aGVsbG8' }, { ...upload, base64: 'YQ==' + '\n' },
    { ...upload, base64: 'YR==' }, { ...upload, base64: 'A'.repeat(2_796_204) }])
    assert.equal((await request({ ...mutation, body })).statusCode, 400);
  for (const idempotencyKey of ['', 'first,second', ['first', 'second'], 'x'.repeat(129)])
    assert.equal((await request({ ...mutation, idempotencyKey })).statusCode, 400);
  assert.equal((await request({ ...mutation, method: 'DELETE', body: upload })).statusCode, 400);
  assert.deepEqual(calls, []);
});
test('portrait absence is404 while invalid output and storage failure are sanitized unavailable responses', async () => {
  const { repository, request, mutation } = fixture();
  repository.getPlayerPortrait = async () => null; assert.equal((await request()).statusCode, 404);
  for (const value of [new Uint8Array([1, 2, 3]), 'https://private-bucket.example/portrait']) {
    repository.getPlayerPortrait = async () => value as any; assert.equal((await request()).statusCode, 503);
  }
  repository.getPlayerPortrait = async () => { throw new Error(`private ${session.email}`); };
  assert(!JSON.stringify(await request()).includes(session.email));
  repository.putOwnerPlayerPortrait = async () => { throw new PortraitInputError(); };
  assert.equal((await request(mutation)).statusCode, 400, 'decoded but malformed bitmap is a client input error');
  repository.putOwnerPlayerPortrait = async () => ({ ...details, objectKey: 'private-key' }) as any;
  const result = await request(mutation); assert.equal(result.statusCode, 503); assert(!JSON.stringify(result).includes('private-key'));
  repository.getPlayerPortrait = async () => { throw new PlayerIdentityError('player_profile_forbidden', 403, 'Access denied.'); };
  assert.equal((await request()).statusCode, 403);
});
test('portrait JSON envelopes have separate upload and removal byte ceilings', () => {
  assert.deepEqual(parsePortraitBody(JSON.stringify(upload), 'PUT'), upload);
  assert.throws(() => parsePortraitBody(' '.repeat(PORTRAIT_JSON_BODY_LIMIT + 1), 'PUT'), RangeError);
  assert.throws(() => parsePortraitBody('"' + 'é'.repeat(4096) + '"', 'DELETE'), RangeError);
});
test('local portrait adapter returns byte-exact PNG with private headers and bounds streaming upload envelopes', async () => {
  const { repository, calls } = fixture(); const before = { profile: process.env.PLAYER_PROFILES_ENABLED, owner: process.env.PLAYER_OWNER_EDITING_ENABLED };
  process.env.PLAYER_PROFILES_ENABLED = 'true'; process.env.PLAYER_OWNER_EDITING_ENABLED = 'true';
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    void handleLocalPlayerPortraitRoute({ request: req, response: res, method: req.method!, route: url.pathname,
      rawQueryString: url.search.slice(1), session: req.headers.cookie === 'session=valid' ? session : null, playerRepository: repository })
      .catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const headers = { cookie: 'session=valid', 'idempotency-key': 'portrait:1', 'content-type': 'application/json' };
    for (const signed of [false, true]) {
      const response = await fetch(`${base}/v1/player-portrait?${query}`, { headers: signed ? headers : {} });
      assert.equal(response.status, signed ? 200 : 401);
      for (const [name, value] of [['cache-control', 'no-store'], ['referrer-policy', 'no-referrer'], ['x-content-type-options', 'nosniff']])
        assert.equal(response.headers.get(name), value);
      if (signed) { assert.equal(response.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await response.arrayBuffer()), png); }
      else await response.text();
    }
    const ownerUrl = `${base}/v1/owner-player-portrait?playerId=alias`;
    const saved = await fetch(ownerUrl, { method: 'PUT', headers, body: JSON.stringify(upload) });
    assert.equal(saved.status, 200); assert(!JSON.stringify(await saved.json()).includes(session.email));
    const count = calls.length;
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(ownerUrl, { method: 'PUT', headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject); req.write('"' + 'a'.repeat(1024 * 1024)); req.end('a'.repeat(2 * 1024 * 1024) + '"');
    });
    assert.equal(status, 413); assert.equal(calls.length, count);
    const removed = await fetch(ownerUrl, { method: 'DELETE', headers, body: JSON.stringify({ expectedRevision: revision }) });
    assert.equal(removed.status, 200); assert.equal((await removed.json()).hasPortrait, false);
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (before.profile === undefined) delete process.env.PLAYER_PROFILES_ENABLED; else process.env.PLAYER_PROFILES_ENABLED = before.profile;
    if (before.owner === undefined) delete process.env.PLAYER_OWNER_EDITING_ENABLED; else process.env.PLAYER_OWNER_EDITING_ENABLED = before.owner;
  }
});
