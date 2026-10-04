import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ACHIEVEMENT_DEFINITIONS, ACHIEVEMENT_RULE_VERSION } from '@3fc/contracts';
import { handlePlayerProfileRoute, type PlayerProfileRepository } from '../player-profile-routes.js';
import { handleLocalPlayerProfileRoute } from '../server.js';
import { PlayerIdentityError } from '../data/player-identity.js';
import { PlayerHistoryError } from '../data/player-history-model.js';
const session = { sessionId: 'session', subject: 'account', email: 'private@example.test', createdAt: '2026-10-03T00:00:00Z', expiresAt: '2026-10-04T00:00:00Z' };
const flags = { profiles: true, achievements: true, ownerEditing: false };
const freshness = { status: 'updating' as const, coverage: 'unknown' as const, revision: 'r1', computedAt: null };
const performance = { player: { playerId: 'canonical', displayName: 'Player', hasPortrait: false }, league: { leagueId: 'league/#%', name: 'League' },
  seasons: [], selectedSeasonId: null, latest: null, season: null, career: null, freshness, capabilities: { editProfile: false, achievements: true } };
function fixture() {
  const calls: Array<{ method: string; input: any }> = [];
  const repository: PlayerProfileRepository = {
    async listMyPlayerProfiles(input) { calls.push({ method: "mine", input }); return { profiles: [{ playerId: "owned", displayName: "Owned", leagueId: "league", leagueName: "League" }], cursor: null, complete: true }; },
    async getPlayerPerformance(input) { calls.push({ method: 'performance', input }); return { ...performance, selectedSeasonId: input.seasonId ?? null }; },
    async getPlayerHistory(input) { calls.push({ method: 'history', input }); return { matches: null, cursor: null, freshness }; },
    async getPlayerAchievements(input) { calls.push({ method: 'achievements', input }); return { leagueId: input.leagueId, playerId: 'canonical', ...input.scope,
      progress: null, honours: null, firstUnlocks: null, latestUnlocks: null, freshness }; },
    async getPlayerUnlocks(input) { calls.push({ method: 'unlocks', input }); return { unlocks: null, cursor: null, freshness }; },
    async listPlayerAccess(input) { calls.push({ method: 'access', input }); return { leagueId: input.leagueId, hasLeagueAcl: false, players: [{ playerId: 'owned', displayName: 'Owned' }], cursor: null, complete: true }; }
  };
  const query = new URLSearchParams({ leagueId: 'league/#%', playerId: 'player/#%', viewerPlayerId: 'viewer/#%' }).toString();
  const request = (route = '/v1/player-profile', rawQueryString = query, overrides: any = {}) => handlePlayerProfileRoute({ method: 'GET', route, rawQueryString, session, repository, flags, ...overrides });
  return { calls, repository, query, request };
}

test('shared routes decode opaque identifiers once and use only session account identities', async () => {
  const { calls, query, request } = fixture();
  assert.equal((await request()).statusCode, 200);
  assert.equal((await request('/v1/player-history', `${query}&seasonId=winter&cursor=opaque`)).statusCode, 200);
  assert.equal((await request('/v1/player-achievements', `${query}&scope=career`)).statusCode, 200);
  assert.equal((await request('/v1/player-unlocks', `${query}&scope=season&seasonId=winter`)).statusCode, 200);
  assert.deepEqual(calls.map(value => value.method), ['performance', 'history', 'achievements', 'unlocks']);
  for (const { input } of calls) {
    assert.equal(input.playerId, 'player/#%'); assert.equal(input.leagueId, 'league/#%'); assert.equal(input.viewerPlayerId, 'viewer/#%');
    assert.equal(input.userId, 'account'); assert.deepEqual(input.userIds, ['account', 'private@example.test']);
  }
  assert.deepEqual(calls[2].input.scope, { scope: 'career', seasonId: null });
  const value = await request('/v1/player-profile', new URLSearchParams({ leagueId: 'league/#%', playerId: '%2F' }).toString());
  assert.equal(value.statusCode, 200); assert.equal(calls.at(-1)!.input.playerId, '%2F');
});

test('anonymous, disabled and invalid queries never reach a repository read', async () => {
  const { calls, query, request } = fixture();
  assert.equal((await request(undefined, undefined, { session: null })).statusCode, 401);
  assert.equal((await request(undefined, undefined, { flags: { ...flags, profiles: false } })).statusCode, 404);
  assert.equal((await request('/v1/player-achievements', `${query}&scope=career`, { flags: { ...flags, achievements: false } })).statusCode, 404);
  const invalid = [`${query}&owner=true`, `${query}&userId=attacker`, `${query}&playerId=duplicate`, `${query}&viewerPlayerId=duplicate`,
    'leagueId=%C0%AF&playerId=p', 'leagueId=l&playerId=%ZZ', 'leagueId=l&playerId=', 'leagueId=l&playerId=%ED%A0%80', `${query}&limit=100`];
  for (const raw of invalid) assert.equal((await request('/v1/player-profile', raw)).statusCode, 400, raw);
  for (const raw of [query, `${query}&scope=career&seasonId=winter`, `${query}&scope=season`, `${query}&scope=game`])
    assert.equal((await request('/v1/player-achievements', raw)).statusCode, 400, raw);
  assert.equal((await request('/v1/player-history', `${query}&cursor=`)).statusCode, 400);
  assert.equal((await request(undefined, undefined, { method: 'POST' })).statusCode, 404);
  assert.deepEqual(calls, []);
});

test('catalogue exposes all23 static definitions with rule scales independently from profile rollout', async () => {
  const { calls, request } = fixture();
  const value = await request('/v1/achievement-catalogue', '', { flags: { ...flags, profiles: false } });
  assert.equal(value.statusCode, 200); assert.equal(value.payload.ruleVersion, ACHIEVEMENT_RULE_VERSION);
  assert.deepEqual((value.payload.achievements as any[]).map(value => value.id), ACHIEVEMENT_DEFINITIONS.map(value => value.id));
  assert.equal((value.payload.milestones as any).commonRepeatEvery, 100);
  assert.equal(JSON.stringify(value).includes(session.email), false);
  assert.equal((await request('/v1/achievement-catalogue', 'leagueId=league')).statusCode, 400);
  assert.equal((await request('/v1/achievement-catalogue', '', { session: null })).statusCode, 401);
  assert.equal((await request('/v1/achievement-catalogue', '', { flags: { ...flags, achievements: false } })).statusCode, 404);
  assert.deepEqual(calls, []);
});

test('access discovery is a bounded safe response and cannot consume an ownership hint', async () => {
  const { calls, request } = fixture();
  const value = await request('/v1/player-access', 'leagueId=league%2F%23%25&limit=20&cursor=bound');
  assert.equal(value.statusCode, 200); assert.equal(calls[0].input.limit, 20); assert.equal(calls[0].input.cursor, 'bound');
  for (const extra of ['limit=21', 'viewerPlayerId=owned', 'playerId=owned', 'limit=0'])
    assert.equal((await request('/v1/player-access', `leagueId=league&${extra}`)).statusCode, 400);
  assert.equal(JSON.stringify(value).includes(session.email), false);
});

test('source errors and invalid or private DTOs are sanitized rather than serialized', async () => {
  const { repository, request } = fixture();
  for (const extra of [{ email: session.email }, { player: { ...performance.player, email: session.email } },
    { league: { ...performance.league, leagueId: 'other' } }, { capabilities: { editProfile: true, achievements: true } }]) {
    repository.getPlayerPerformance = async () => ({ ...performance, ...extra }) as any;
    const result = await request(); assert.equal(result.statusCode, 503); assert.equal(JSON.stringify(result).includes(session.email), false);
  }
  repository.getPlayerPerformance = async () => { throw new Error(`Raw ${session.email}`); };
  assert.equal(JSON.stringify(await request()).includes(session.email), false);
  for (const [error, status] of [[new PlayerIdentityError('player_profile_forbidden', 403, 'Denied'), 403],
    [new PlayerHistoryError('invalid_cursor', 'unsafe raw'), 400], [new PlayerHistoryError('history_changed', 'unsafe raw'), 409],
    [new PlayerHistoryError('history_unavailable', 'unsafe raw'), 503]] as const) {
    repository.getPlayerPerformance = async () => { throw error; };
    const value = await request(); assert.equal(value.statusCode, status); assert.equal(JSON.stringify(value).includes('unsafe raw'), false);
  }
});

test('achievement DTOs must match the requested league and scope', async () => {
  const { repository, request, query } = fixture();
  repository.getPlayerAchievements = async () => ({ leagueId: 'other', playerId: 'canonical', scope: 'season', seasonId: 'winter',
    progress: null, honours: null, firstUnlocks: null, latestUnlocks: null, freshness });
  assert.equal((await request('/v1/player-achievements', `${query}&scope=career`)).statusCode, 503);
});

test('local adapter matches shared payloads and applies no-store/referrer headers to success and denial', async () => {
  const { repository, query, request } = fixture(); const before = { profile: process.env.PLAYER_PROFILES_ENABLED, achievements: process.env.PLAYER_ACHIEVEMENTS_ENABLED };
  process.env.PLAYER_PROFILES_ENABLED = 'true'; process.env.PLAYER_ACHIEVEMENTS_ENABLED = 'true';
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://localhost');
    void handleLocalPlayerProfileRoute({ request: req, response: res, method: req.method!, route: url.pathname,
      rawQueryString: url.search.slice(1), session: req.headers.cookie === 'session=valid' ? session : null, playerRepository: repository })
      .catch(() => { res.writeHead(500); res.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const route of ['/v1/player-profile', '/v1/my-player-profiles']) for (const signedIn of [false, true]) {
      const selectedQuery = route === '/v1/player-profile' ? query : '';
      const response = await fetch(`${base}${route}?${selectedQuery}`, { headers: signedIn ? { cookie: 'session=valid' } : {} });
      assert.equal(response.status, signedIn ? 200 : 401); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      const body = await response.json(); assert.deepEqual(body, (await request(route, selectedQuery, signedIn ? {} : { session: null })).payload);
      assert.equal(JSON.stringify(body).includes(session.email), false);
    }
  } finally {
    server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (before.profile === undefined) delete process.env.PLAYER_PROFILES_ENABLED; else process.env.PLAYER_PROFILES_ENABLED = before.profile;
    if (before.achievements === undefined) delete process.env.PLAYER_ACHIEVEMENTS_ENABLED; else process.env.PLAYER_ACHIEVEMENTS_ENABLED = before.achievements;
  }
});


test('own profile discovery accepts only pagination and uses session identities', async () => {
  const { calls, request, repository } = fixture();
  const result = await request('/v1/my-player-profiles', 'cursor=next');
  assert.equal(result.statusCode, 200);
  assert.deepEqual(calls[0], { method: 'mine', input: { userId: 'account', userIds: ['account', 'private@example.test'], cursor: 'next' } });
  for (const query of ['playerId=other', 'userId=other', 'leagueId=league', 'cursor=', 'cursor=a&cursor=b'])
    assert.equal((await request('/v1/my-player-profiles', query)).statusCode, 400);
  assert.equal((await request('/v1/my-player-profiles', '', { session: null })).statusCode, 401);
  assert.equal((await request('/v1/my-player-profiles', '', { flags: { ...flags, profiles: false } })).statusCode, 404);
  repository.listMyPlayerProfiles = async () => ({ profiles: [], cursor: 'next', complete: true });
  assert.equal((await request('/v1/my-player-profiles', '')).statusCode, 503);
});
