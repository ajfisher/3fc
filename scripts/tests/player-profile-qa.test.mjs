import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, chmod, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  QA, QaAcceptanceError, createQaState, validateQaState, validateMutationIntent, readPrivateState, writePrivateState,
  qaRequest, sessionCookie, safePlayerResponse, createMutationJournal, boundedPoll, syntheticPortrait, assertProcessedPortrait, runQaAcceptance, parseQaArguments,
} from '../qa/player-profile-acceptance.mjs';
const head = 'a'.repeat(40), run = '12345', id = '11111111-1111-4111-8111-111111111111';
const state = () => createQaState(head, run, id);
const headers = () => new Headers({ 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
function processed(bytes) { const chunks = [bytes.subarray(0, 8)]; for (let at = 8; at < bytes.length;) { const length = bytes.readUInt32BE(at) + 12; if (bytes.toString('ascii', at + 4, at + 8) !== 'tEXt') chunks.push(bytes.subarray(at, at + length)); at += length; } return Buffer.concat(chunks); }

test('CLI requires explicit QA opt-in and exact head/run; recovered state cannot substitute real identities', () => {
  assert.throws(() => parseQaArguments([]), QaAcceptanceError);
  assert.throws(() => parseQaArguments(['--qa-synthetic', '--head', head, '--run', run, '--api', 'https://production']), QaAcceptanceError);
  assert.deepEqual(parseQaArguments(['--qa-synthetic', '--head', head, '--run', run]), { '--head': head, '--run': run });
  const original = state(); assert.equal(validateQaState(original, head, run), original);
  for (const mutate of [value => { value.ids.league = 'real-league'; }, value => { value.actors.owner.email = 'real@example.com'; }, value => { value.actors.extra = value.actors.owner; }, value => { value.players.owner = 'real-player'; }]) {
    const copy = structuredClone(original); mutate(copy); assert.throws(() => validateQaState(copy, head, run), QaAcceptanceError);
  }
});
test('recovered rehashed mutation cannot escape generated fixture scope', () => {
  const value = state(), request = { path: '/v1/leagues', method: 'POST', actor: 'organiser', body: { leagueId: value.ids.league, name: `QA Player Cards ${value.id}` } };
  validateMutationIntent(value, 'league', request);
  for (const change of [{ path: '/v1/leagues/real' }, { body: { ...request.body, leagueId: 'real' } }, { actor: 'owner' }, { method: 'DELETE' }, { cookie: 'override' }])
    assert.throws(() => validateMutationIntent(value, 'league', { ...request, ...change }), QaAcceptanceError);
  validateMutationIntent(value, 'finish-game', { path: `/v1/games/${value.ids.game}/finish`, method: 'POST', actor: 'organiser' });
  value.steps['goal-3'] = { outcome: { body: { goal: { eventId: 'owned-event' } } } };
  validateMutationIntent(value, 'delete-goal', { path: `/v1/games/${value.ids.game}/goals/owned-event`, method: 'DELETE', actor: 'organiser' });
});
test('private state persists atomically with restrictive permissions and rejects symlinks/public files', async () => {
  const directory = await mkdtemp(join(tmpdir(), '3fc-qa-unit-')); await chmod(directory, 0o700); const path = join(directory, 'state.json');
  try {
    await writePrivateState(path, state()); assert.equal((await readPrivateState(path, head, run)).id, id);
    await chmod(path, 0o644); await assert.rejects(readPrivateState(path, head, run), QaAcceptanceError); await chmod(path, 0o600);
    await symlink(path, join(directory, 'link.json')); await assert.rejects(readPrivateState(join(directory, 'link.json'), head, run), QaAcceptanceError);
    await chmod(directory, 0o755); await assert.rejects(writePrivateState(path, state()), QaAcceptanceError);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('HTTP transport pins QA, consumes bounded response body, and suppresses raw credential failures', async () => {
  let seen;
  const result = await qaRequest('/v1/auth/session', { cookie: 'private-cookie' }, async (url, options) => { seen = { url, options }; return new Response('{"authenticated":true}', { headers: headers() }); });
  assert.equal(seen.url, `${QA.api}/v1/auth/session`); assert.equal(seen.options.headers.Origin, QA.site); assert.equal(seen.options.redirect, 'error'); assert.equal(result.body.authenticated, true);
  await assert.rejects(qaRequest('https://3fc.football/v1/leagues', {}, async () => assert.fail('must not fetch')), QaAcceptanceError);
  await assert.rejects(qaRequest('/v1/auth/session', {}, async () => { throw new Error('private-cookie token private@example.com'); }), error => !String(error).includes('private-cookie') && error.code === 'http_transport_failed');
  await assert.rejects(qaRequest('/v1/auth/session', {}, async () => new Response(new Uint8Array(3 * 1024 * 1024 + 1))), QaAcceptanceError);
});
test('cookies and safe response checks reject unsafe attributes and deeply nested private data', () => {
  assert.equal(sessionCookie(new Headers({ 'set-cookie': 'threefc_session=secret; Path=/; HttpOnly; Secure; SameSite=Lax' })), 'secret');
  assert.throws(() => sessionCookie(new Headers({ 'set-cookie': 'threefc_session=secret; HttpOnly' })), QaAcceptanceError);
  assert.throws(() => safePlayerResponse({ player: { details: [{ email: 'secret@example.com' }] } }), QaAcceptanceError);
  safePlayerResponse({ playerId: 'public-id', displayName: 'Name', freshness: { revision: 'revision' } });
});
test('ambiguous mutation is persisted before request and retries identical original body/key on resume', async () => {
  const value = state(), saves = [], requests = []; let fail = true;
  const journal = createMutationJournal(value, async () => saves.push(structuredClone(value)), async (path, input) => { requests.push({ path, ...input }); assert(saves.length); if (fail) { fail = false; throw new Error('lost acknowledgement'); } return { status: 201, body: { leagueId: value.ids.league } }; });
  const make = () => ({ path: '/v1/leagues', method: 'POST', actor: 'organiser', body: { leagueId: value.ids.league, name: `QA Player Cards ${value.id}` } });
  await assert.rejects(journal('league', make, [201])); await journal('league', () => assert.fail('must reuse journal'), [201]); assert.deepEqual(requests[0], requests[1]);
  await journal('league', () => assert.fail('must reuse receipt'), [201]); assert.equal(requests.length, 2);
});
test('polling stops at strict count/deadline and distinguishes unknown projections from confirmed zero', async () => {
  let now = 0, reads = 0;
  await assert.rejects(boundedPoll(async () => { reads++; return null; }, value => value === 0, { now: () => now, wait: async ms => { now += ms; }, timeout: 5000 }), error => error.code === 'projection_poll_timeout');
  assert.equal(reads, 2); assert.equal(await boundedPoll(async () => 0, value => value === 0), 0);
});
test('synthetic PNG verifies only after server-sized output and metadata stripping', () => {
  assert.throws(() => assertProcessedPortrait(syntheticPortrait()), QaAcceptanceError);
  assert.throws(() => assertProcessedPortrait(syntheticPortrait([26, 96, 61], 512)), QaAcceptanceError);
  const valid = processed(syntheticPortrait([26, 96, 61], 512)); assertProcessedPortrait(valid);
  valid[valid.length - 1] ^= 1; assert.throws(() => assertProcessedPortrait(valid), QaAcceptanceError);
});

function fakeService(value) {
  const players = new Map(), claims = new Map(), receipts = new Map(), goals = new Map(), calls = [], thirds = [1, 2, 3].map(third => ({ third, startedAt: null, finishedAt: null }));
  let finished = false, revision = 0, sequence = 0, photo = null; const rev = () => (++revision).toString(16).padStart(64, '0');
  const safe = player => ({ playerId: player.id, displayName: player.name, hasPortrait: player.photo, revision: player.revision });
  const result = (status, body, extra = {}) => ({ status, body, headers: new Headers({ ...Object.fromEntries(headers()), ...extra }) });
  const counts = () => ({ goal: goals.size, 'hat-trick': goals.size >= 3 ? 1 : 0, 'message-sent': [...goals.values()].filter(goal => !goal.postCompletion).length,
    'master-provider': [...goals.values()].filter(goal => goal.assistPlayerIds.length).length >= 3 ? 1 : 0 });
  async function request(path, input = {}) {
    calls.push({ path, ...input }); const u = new URL(path, QA.api), method = input.method ?? 'GET', actor = input.cookie, body = input.body, key = input.key;
    if (u.pathname === '/v1/auth/logout') return result(204, null);
    const inputHash = JSON.stringify([method, path, body]);
    if (key && receipts.has(key)) { const prior = receipts.get(key); return prior.hash === inputHash ? structuredClone(prior.response) : result(409, { error: 'conflict' }); }
    const save = response => { if (key && response.status < 300) receipts.set(key, { hash: inputHash, response: { ...response, headers: undefined } }); return response; };
    if (u.pathname === '/v1/leagues') return save(result(201, { leagueId: value.ids.league }));
    if (u.pathname.endsWith('/seasons')) return save(result(201, { seasonId: value.ids.season }));
    if (u.pathname.endsWith('/sessions')) return save(result(201, { sessionId: value.ids.session }));
    if (u.pathname.endsWith('/games') && method === 'POST') return save(result(201, { gameId: value.ids.game, joinCode: 'ABCD2345' }));
    if (u.pathname === '/v1/league-players') {
      if ([...u.searchParams.keys()].some(key => !['leagueId', 'query', 'cursor', 'limit'].includes(key))) return result(400, { error: 'bad_request' });
      if (method === 'POST') { players.set(body.playerId, { id: body.playerId, name: body.nickname, photo: false, revision: rev() }); return save(result(201, { player: { playerId: body.playerId, nickname: body.nickname } })); }
      return result(200, { players: [...players.values()].map(p => ({ playerId: p.id, nickname: p.name })), cursor: null });
    }
    if (u.pathname.startsWith('/v1/join/')) { const role = body.nickname.includes('owner') ? 'owner' : 'other', id = `synthetic-${role}`; players.set(id, { id, name: body.nickname, photo: false, revision: rev() }); return save(result(201, { player: { playerId: id, nickname: body.nickname } })); }
    if (u.pathname === '/v1/player-proofs/preview') return result(200, { preview: { confirmation: 'proof-confirmation' } });
    if (u.pathname === '/v1/player-proofs/claim') { claims.set(u.searchParams.get('playerId'), actor); return result(200, { player: { playerId: u.searchParams.get('playerId') } }); }
    const targetId = u.searchParams.get('playerId'), target = players.get(targetId);
    if (u.pathname === '/v1/owner-player-profile' || u.pathname === '/v1/owner-player-portrait') {
      if (!actor) return result(401, {}); if (!target || claims.get(targetId) !== actor) return result(403, {});
      if (method === 'GET') return result(200, { ...safe(target), email: value.actors[actor].email });
      if (target.revision !== body.expectedRevision) return result(409, {});
      if (method === 'PATCH') target.name = body.displayName;
      else if (method === 'PUT') { target.photo = true; const colour = body.base64 === syntheticPortrait([26, 96, 61]).toString('base64') ? [26, 96, 61] : [184, 135, 32]; photo = processed(syntheticPortrait(colour, 512)); }
      else { target.photo = false; photo = null; }
      target.revision = rev(); return save(result(200, safe(target)));
    }
    const profileRead = ['/v1/player-profile', '/v1/player-history', '/v1/player-achievements', '/v1/player-unlocks', '/v1/player-portrait'].includes(u.pathname);
    if (profileRead) {
      if (!actor) return result(401, {});
      if (actor !== 'organiser' && claims.get(targetId) !== actor && claims.get(u.searchParams.get('viewerPlayerId')) !== actor) return result(403, {});
      if (u.pathname === '/v1/player-portrait') return photo ? result(200, photo, { 'content-type': 'image/png', 'x-content-type-options': 'nosniff' }) : result(404, { error: 'portrait_not_found' });
      const fresh = { status: 'ready', coverage: 'complete', revision: `source-${sequence}`, computedAt: new Date().toISOString() };
      const zero = targetId === value.ids.zero, other = targetId === 'synthetic-other', n = zero ? 0 : other ? 0 : goals.size, assists = other ? [...goals.values()].filter(goal => goal.assistPlayerIds.length).length : 0;
      const totals = { played: zero ? 0 : finished ? 1 : 0, goals: n, assists, wins: !zero && !other && finished ? 1 : 0, draws: 0, losses: other && finished ? 1 : 0, ownGoals: 0, goalsPerGame: n };
      if (u.pathname === '/v1/player-profile') return result(200, { player: { playerId: targetId, displayName: target?.name, hasPortrait: target?.photo }, league: { leagueId: value.ids.league, name: 'QA' }, selectedSeasonId: value.ids.season, seasons: [{ seasonId: value.ids.season, name: 'QA synthetic season' }], season: totals, career: totals, latest: zero ? null : { gameId: value.ids.game, goals: n }, freshness: fresh });
      if (u.pathname === '/v1/player-history') return result(200, { matches: [{ gameId: value.ids.game, goals: n }], cursor: null, freshness: fresh });
      const earned = counts()['hat-trick'] ? [{ achievementId: 'hat-trick', id: 'stable-hat' }] : [];
      if (u.pathname === '/v1/player-unlocks') return result(200, { unlocks: earned, cursor: null, freshness: fresh });
      return result(200, { playerId: targetId, leagueId: value.ids.league, honours: earned, progress: Object.entries(counts()).map(([achievementId, count]) => ({ achievementId, count })), freshness: fresh });
    }
    if (u.pathname === '/v1/achievement-catalogue') return result(200, { ruleVersion: 1, achievements: Array.from({ length: 23 }, (_, id) => ({ id: String(id) })) });
    if (u.pathname.endsWith('/roster/synthetic-owner') || u.pathname.endsWith('/roster/synthetic-other')) return save(result(200, { playerId: u.pathname.split('/').at(-1), teamId: body.teamId }));
    if (u.pathname === `/v1/games/${value.ids.game}`) return result(200, { gameId: value.ids.game, thirds });
    const transition = /\/thirds\/([123])\/(start|finish)$/.exec(u.pathname);
    if (transition) { thirds[Number(transition[1]) - 1][transition[2] === 'start' ? 'startedAt' : 'finishedAt'] = new Date().toISOString(); return result(200, { thirds }); }
    if (u.pathname.endsWith('/finish')) { finished = true; sequence++; return save(result(200, { gameId: value.ids.game, status: 'finished' })); }
    if (u.pathname.endsWith('/goals')) { const eventId = `event-${++sequence}`; const goal = { ...body, eventId, third: finished ? 3 : 1, elapsedSeconds: 0, postCompletion: finished }; goals.set(eventId, goal); return save(result(201, { goal, scoreboard: {}, timeline: [...goals.values()] })); }
    if (/\/goals\/event-\d+$/.test(u.pathname) && method === 'DELETE') { goals.delete(u.pathname.split('/').at(-1)); sequence++; return save(result(200, { deleted: true, scoreboard: {}, timeline: [...goals.values()] })); }
    throw new Error('Unexpected synthetic route');
  }
  return { request, calls };
}

test('complete injected HTTP smoke claims real-role contexts, reconciles awards, edits owner and replaces/removes private portraits', async () => {
  const value = state(), service = fakeService(value); let saves = 0, cleanups = 0;
  const report = await runQaAcceptance(value, { request: service.request, persist: async () => { saves++; if (value.status === 'complete') assert.equal(cleanups, 1, 'complete can only persist after cleanup'); }, authenticate: async role => { value.actors[role].cookie = role; }, cleanupAuth: async () => { assert.equal(value.status, 'pending'); cleanups++; }, poll: async (read, accept) => { const result = await read(); assert(accept(result), 'synthetic projection must satisfy actual smoke predicate'); return result; } });
  assert.equal(report.status, 'passed'); assert.equal(report.physicalPortraitCleanup, 'not-verified'); assert.equal(value.status, 'complete'); assert(saves > 30); assert.equal(cleanups, 1);
  assert(Object.values(value.actors).every(actor => actor.cookie === null)); assert.equal(service.calls.filter(call => call.path === '/v1/auth/logout').length, 3);
  const participantRead = service.calls.find(call => call.cookie === 'other' && call.path.startsWith('/v1/player-profile?') && call.path.includes('viewerPlayerId=synthetic-other'));
  assert(participantRead, 'other participant must supply its verified viewer identity'); assert.equal(value.report.hatTrickId, 'stable-hat'); assert.notEqual(value.report['portrait-a'], value.report['portrait-b']);
  assert(service.calls.some(call => call.path.startsWith('/v1/league-players?') && new URL(call.path, QA.api).searchParams.has('query')), 'directory name search uses strict query contract');
  assert(service.calls.some(call => call.method === 'DELETE' && call.path.includes('/goals/'))); assert(service.calls.some(call => call.path.startsWith('/v1/owner-player-portrait?') && call.method === 'DELETE'));
});
test('failed smoke logs out every known actor and preserves incomplete journal for resume', async () => {
  const value = state(), calls = []; let recovered = false;
  await assert.rejects(runQaAcceptance(value, { persist: async () => {}, authenticate: async role => { value.actors[role].cookie = role; },
    request: async (path, input) => { calls.push(path); if (path === '/v1/auth/logout') return { status: 204 }; throw new Error('private transport'); }, cleanupAuth: async () => { recovered = true; } }));
  assert.equal(calls.filter(path => path === '/v1/auth/logout').length, 3); assert(recovered); assert.equal(value.status, 'pending'); assert(value.steps.league.request); assert.equal(value.steps.league.outcome, null);
});
test('cleanup failure remains resumable even after every HTTP acceptance phase passed', async () => {
  const value = state(), service = fakeService(value);
  const dependencies = { request: service.request, persist: async () => {}, authenticate: async role => { value.actors[role].cookie = role; }, poll: async (read, accept) => { const result = await read(); assert(accept(result)); return result; } };
  await assert.rejects(runQaAcceptance(value, { ...dependencies, cleanupAuth: async () => { throw new Error('temporary auth cleanup failure'); } }), error => error.code === 'synthetic_logout_incomplete');
  assert.equal(value.status, 'pending'); assert(value.completed['portrait-remove']);
  const writesBefore = service.calls.filter(call => call.method && call.method !== 'GET' && call.path !== '/v1/auth/logout').length;
  await runQaAcceptance(value, dependencies); assert.equal(value.status, 'complete');
  assert.equal(service.calls.filter(call => call.method && call.method !== 'GET' && call.path !== '/v1/auth/logout').length, writesBefore, 'resume does not repeat source/profile writes');
});
test('resume continues a persisted anonymous join before ownership claim instead of requiring ownership prematurely', async () => {
  const value = state(), service = fakeService(value); let interrupted = false;
  const dependencies = { request: service.request, authenticate: async role => { value.actors[role].cookie = role; }, poll: async (read, accept) => { const result = await read(); assert(accept(result)); return result; } };
  await assert.rejects(runQaAcceptance(value, { ...dependencies, persist: async () => {
    if (!interrupted && value.players.owner && !value.completed['claim-owner']) { interrupted = true; throw new Error('Interruption after joined player persist'); }
  } }));
  assert(value.players.owner); assert.equal(value.completed['claim-owner'], undefined);
  assert.equal(service.calls.filter(call => call.path.startsWith('/v1/player-proofs/claim?')).length, 0);
  await runQaAcceptance(value, { ...dependencies, persist: async () => {} }); assert.equal(value.status, 'complete');
  assert.equal(service.calls.filter(call => call.path.startsWith('/v1/join/') && call.body.nickname.includes('owner')).length, 1, 'resume reuses joined player receipt');
});
test('resume discovers a committed claim whose acknowledgement was lost without replaying a stale confirmation', async () => {
  const value = state(), service = fakeService(value); let loseAck = true;
  const request = async (path, input) => { const result = await service.request(path, input); if (loseAck && path.startsWith('/v1/player-proofs/claim?')) { loseAck = false; throw new Error('Claim acknowledgement lost'); } return result; };
  const dependencies = { request, persist: async () => {}, authenticate: async role => { value.actors[role].cookie = role; }, poll: async (read, accept) => { const result = await read(); assert(accept(result)); return result; } };
  await assert.rejects(runQaAcceptance(value, dependencies)); assert.equal(value.completed['claim-owner'], undefined);
  await runQaAcceptance(value, dependencies); assert.equal(value.status, 'complete');
  assert.equal(service.calls.filter(call => call.path.startsWith('/v1/player-proofs/claim?') && call.cookie === 'owner').length, 1, 'authoritative owner read proves the earlier claim');
});
