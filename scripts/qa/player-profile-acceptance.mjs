#!/usr/bin/env node
// Explicit QA-only, real HTTP acceptance. Synthetic authentication delivery is
// intercepted; no real email/account/session or pre-existing league is used.
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { lstat, open, rename, readFile, mkdtemp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';

export const QA = Object.freeze({ site: 'https://qa.3fc.football', api: 'https://qa-api.3fc.football', tableName: '3fc-qa-app', region: 'ap-southeast-2', profile: '3fc-agent', accountId: '301691475109' });
export class QaAcceptanceError extends Error { constructor(code) { super('QA acceptance failed; private detail suppressed'); this.code = code; } }
function check(condition, code) { if (!condition) throw new QaAcceptanceError(code); }
const hash = value => createHash('sha256').update(JSON.stringify([value])).digest('hex');
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const q = value => new URLSearchParams(value).toString();
const phases = ['fixture-source', 'outside-boundary', 'claim-owner', 'claim-other', 'ownership-privacy', 'completed-match', 'initial-statistics', 'correction-revoke', 'correction-reinstate', 'owner-name', 'portrait-a', 'portrait-b', 'portrait-remove'];

export function createQaState(head, runId, id = randomUUID()) {
  check(/^[a-f0-9]{40}$/.test(head) && /^\d+$/.test(runId) && uuid(id), 'invalid_run_identity');
  const actor = name => ({ email: `qa-player-${id}-${name}@example.com`, cookie: null, tokens: [] });
  return { version: 1, id, head, runId, createdAt: new Date().toISOString(), status: 'pending',
    ids: { league: `qa-profile-${id}`, season: `qa-season-${id}`, session: `qa-session-${id}`, game: `qa-game-${id}`, zero: `qa-zero-${id}` },
    actors: { organiser: actor('organiser'), owner: actor('owner'), other: actor('other') }, proofs: {}, steps: {}, completed: {}, players: {}, report: { physicalPortraitCleanup: 'not-verified' } };
}
export function validateQaState(value, head, runId) {
  check(value?.version === 1 && uuid(value.id) && value.head === head && value.runId === runId, 'state_scope_mismatch');
  const expected = createQaState(head, runId, value.id);
  check(JSON.stringify(value.ids) === JSON.stringify(expected.ids) && ['pending', 'complete'].includes(value.status), 'state_scope_mismatch');
  check(JSON.stringify(Object.keys(value.actors ?? {}).sort()) === JSON.stringify(['organiser', 'other', 'owner']), 'state_actor_mismatch');
  check(typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)), 'state_timestamp');
  for (const role of ['organiser', 'owner', 'other']) {
    const actor = value.actors?.[role];
    check(actor?.email === expected.actors[role].email && Array.isArray(actor.tokens) && actor.tokens.length <= 40
      && (actor.cookie === null || typeof actor.cookie === 'string' && actor.cookie.length <= 4096 && !/[\s\r\n;]/.test(actor.cookie))
      && actor.tokens.every(token => token.email === actor.email && typeof token.tokenId === 'string' && token.tokenId.startsWith('qa-player-') && uuid(token.tokenId.slice(10))), 'state_actor_mismatch');
  }
  check(value.steps && value.completed && value.proofs && value.players, 'state_shape_invalid');
  check(Object.entries(value.completed).every(([name, complete]) => phases.includes(name) && complete === true)
    && (value.status !== 'complete' || phases.every(name => value.completed[name])), 'state_completion_invalid');
  for (const role of Object.keys(value.players)) check(['owner', 'other'].includes(role) && value.players[role] === value.steps[`join-${role}`]?.outcome?.body?.player?.playerId, 'state_player_mismatch');
  for (const [name, entry] of Object.entries(value.steps)) validateMutationIntent(value, name, entry.request);
  return value;
}
export async function readPrivateState(path, head, runId) {
  const stat = await lstat(path); check(stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o077) === 0 && stat.size <= 8 * 1024 * 1024, 'state_permissions');
  return validateQaState(JSON.parse(await readFile(path, 'utf8')), head, runId);
}
export async function writePrivateState(path, state) {
  const parent = await lstat(dirname(path)); check(parent.isDirectory() && !parent.isSymbolicLink() && (parent.mode & 0o077) === 0, 'state_directory_permissions');
  const temporary = `${path}.${randomUUID()}.next`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}
export function privateHeaders(headers) {
  check(headers.get('cache-control') === 'no-store' && headers.get('referrer-policy') === 'no-referrer', 'private_headers_missing');
}
export function safePlayerResponse(body) {
  const banned = new Set(['email', 'claimedByUserId', 'userId', 'userIds', 'objectKey', 'token', 'secret', 'cookie', 'preferences']);
  const walk = value => { if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { check(!banned.has(key), 'private_field_exposed'); walk(child); } };
  walk(body);
}
export function sessionCookie(headers) {
  const value = headers.get('set-cookie') ?? '', match = /^threefc_session=([^;]+);/.exec(value);
  check(match && /;\s*HttpOnly/i.test(value) && /;\s*Secure/i.test(value) && /;\s*SameSite=Lax/i.test(value), 'session_cookie_invalid');
  return match[1];
}
export async function qaRequest(path, { method = 'GET', cookie, body, key, binary = false } = {}, transport = fetch) {
  check(typeof path === 'string' && path.startsWith('/v1/') && !path.includes('\\') && new URL(path, QA.api).origin === QA.api, 'request_scope_invalid');
  try {
    const response = await transport(`${QA.api}${path}`, { method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(35_000), headers: {
      Origin: QA.site, ...(cookie ? { Cookie: `threefc_session=${cookie}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(key ? { 'Idempotency-Key': key } : {}),
    }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const chunks = []; let size = 0;
    if (response.body) for await (const chunk of response.body) { size += chunk.byteLength; check(size <= 3 * 1024 * 1024, 'response_too_large'); chunks.push(chunk); }
    const bytes = Buffer.concat(chunks);
    return { status: response.status, headers: response.headers, body: binary && response.status === 200 ? bytes : bytes.length ? JSON.parse(bytes.toString('utf8')) : null };
  } catch { throw new QaAcceptanceError('http_transport_failed'); }
}
/** Persist the complete intended mutation before sending; an ambiguous response
 * reuses the same payload/key on resume, including stale expectedRevision. */
export function createMutationJournal(state, persist, send) {
  return async (name, makeRequest, statuses = [200]) => {
    check(/^[a-z0-9-]+$/.test(name), 'step_name_invalid');
    let entry = state.steps[name];
    if (!entry) { const request = await makeRequest(); validateMutationIntent(state, name, request); entry = state.steps[name] = { request, hash: hash(request), key: `${state.id}:${name}`, outcome: null }; await persist(); }
    validateMutationIntent(state, name, entry.request);
    check(entry.hash === hash(entry.request) && entry.key === `${state.id}:${name}`, 'journal_changed');
    if (entry.outcome) return entry.outcome;
    const result = await send(entry.request.path, { ...entry.request, key: entry.key });
    check(statuses.includes(result.status), 'mutation_status');
    entry.outcome = { status: result.status, body: result.body }; await persist(); return entry.outcome;
  };
}
export function validateMutationIntent(state, name, request) {
  check(request && Object.keys(request).every(key => ['path', 'body', 'actor', 'method'].includes(key)), 'mutation_scope_invalid');
  const { league: l, season: s, session: x, game: g, zero } = state.ids, game = `/v1/games/${g}`;
  let path, body, actor = 'organiser', method = 'POST';
  if (name === 'league') { path = '/v1/leagues'; body = { leagueId: l, name: `QA Player Cards ${state.id}` }; }
  else if (name === 'season') { path = `/v1/leagues/${l}/seasons`; body = { seasonId: s, name: 'QA synthetic season', startsOn: state.createdAt.slice(0, 10) }; }
  else if (name === 'session') { path = `/v1/leagues/${l}/seasons/${s}/sessions`; body = { sessionId: x, sessionDate: state.createdAt.slice(0, 10) }; }
  else if (name === 'game') { path = `/v1/leagues/${l}/seasons/${s}/sessions/${x}/games`; body = { gameId: g, gameStartTs: state.createdAt, thirdLengthMinutes: 20 }; }
  else if (name === 'zero-player') { path = `/v1/league-players?${q({ leagueId: l })}`; body = { playerId: zero, nickname: `QA zero ${state.id.slice(0, 8)}` }; }
  else if (/^join-(owner|other)$/.test(name)) {
    const role = name.slice(5), proof = state.proofs[role]; actor = null;
    check(proof && /^[A-Za-z0-9_-]{20,64}$/.test(proof.proofId) && /^[A-Za-z0-9_-]{43}$/.test(proof.secret)
      && proof.verifier === createHash('sha256').update(proof.secret).digest('hex') && state.joinCode === state.steps.game?.outcome?.body?.joinCode && /^[A-Z2-9]{8}$/.test(state.joinCode), 'state_proof_mismatch');
    path = `/v1/join/${state.joinCode}`; body = { nickname: `QA ${role} ${state.id.slice(0, 8)}`, claimProof: { proofId: proof.proofId, verifier: proof.verifier } };
  } else if (/^roster-(owner|other)$/.test(name)) {
    const role = name.slice(7); check(state.players[role], 'state_player_mismatch'); method = 'PUT'; path = `${game}/roster/${encodeURIComponent(state.players[role])}`; body = { teamId: role === 'owner' ? 'red' : 'blue' };
  } else if (/^goal-[123]$/.test(name) || name === 'post-completion-goal') {
    check(state.players.owner && state.players.other, 'state_player_mismatch'); path = `${game}/goals`;
    body = { scoringTeamId: 'red', concedingTeamId: 'blue', scorerPlayerId: state.players.owner, assistPlayerIds: name === 'post-completion-goal' ? [] : [state.players.other], ownGoal: false };
  } else if (name === 'finish-game') path = `${game}/finish`;
  else if (name === 'delete-goal') { const id = state.steps['goal-3']?.outcome?.body?.goal?.eventId; check(typeof id === 'string' && id.length > 0, 'state_goal_identity'); path = `${game}/goals/${encodeURIComponent(id)}`; method = 'DELETE'; }
  else if (['rename', 'portrait-a', 'portrait-b', 'remove-portrait'].includes(name)) {
    check(state.players.owner && /^[a-f0-9]{64}$/.test(request?.body?.expectedRevision ?? ''), 'state_revision'); actor = 'owner';
    const expectedRevision = request.body.expectedRevision;
    if (name === 'rename') { path = `/v1/owner-player-profile?${q({ playerId: state.players.owner })}`; method = 'PATCH'; body = { displayName: `QA renamed ${state.id.slice(0, 8)}`, expectedRevision }; }
    else { path = `/v1/owner-player-portrait?${q({ playerId: state.players.owner })}`; method = name === 'remove-portrait' ? 'DELETE' : 'PUT'; body = name === 'remove-portrait' ? { expectedRevision }
      : { expectedRevision, contentType: 'image/png', base64: syntheticPortrait(name === 'portrait-a' ? [26, 96, 61] : [184, 135, 32]).toString('base64') }; }
  } else throw new QaAcceptanceError('mutation_scope_invalid');
  check(request?.path === path && request.actor === actor && request.method === method && hash(request.body) === hash(body), 'mutation_scope_invalid');
}
export async function boundedPoll(read, accept, { wait = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, progress = () => {}, timeout = 300_000 } = {}) {
  const end = now() + timeout;
  for (let attempt = 0; attempt < 120 && now() < end; attempt++) {
    const value = await read(); if (accept(value)) return value;
    if (attempt % 10 === 0) progress(attempt); await wait(2500);
  }
  throw new QaAcceptanceError('projection_poll_timeout');
}
function crc32(bytes) { let n = 0xffffffff; for (const byte of bytes) { n ^= byte; for (let bit = 0; bit < 8; bit++) n = n & 1 ? (n >>> 1) ^ 0xedb88320 : n >>> 1; } return (n ^ 0xffffffff) >>> 0; }
function pngChunk(type, data) { const body = Buffer.concat([Buffer.from(type), data]), size = Buffer.alloc(4), crc = Buffer.alloc(4); size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body)); return Buffer.concat([size, body, crc]); }
export function syntheticPortrait(colour = [26, 96, 61], width = 64, height = width) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * height); for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 3; c++) rows[y * (width * 3 + 1) + 1 + x * 3 + c] = colour[c];
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('tEXt', Buffer.from('Comment\0QA-SYNTHETIC-METADATA')), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))]);
}
export function assertProcessedPortrait(bytes) {
  check(Buffer.isBuffer(bytes) && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'portrait_format');
  const chunks = []; let offset = 8;
  while (offset < bytes.length) {
    check(offset + 12 <= bytes.length, 'portrait_chunk_invalid'); const length = bytes.readUInt32BE(offset), end = offset + 12 + length;
    check(end <= bytes.length, 'portrait_chunk_invalid'); const kind = bytes.toString('ascii', offset + 4, offset + 8); chunks.push(kind);
    if (kind === 'IHDR') check(length === 13 && bytes.readUInt32BE(offset + 8) === 512 && bytes.readUInt32BE(offset + 12) === 512, 'portrait_dimensions');
    check(bytes.readUInt32BE(end - 4) === crc32(bytes.subarray(offset + 4, end - 4)), 'portrait_crc'); offset = end;
  }
  check(chunks[0] === 'IHDR' && chunks.at(-1) === 'IEND' && chunks.includes('IDAT') && !chunks.some(kind => ['eXIf', 'iCCP', 'iTXt', 'tEXt', 'zTXt'].includes(kind)), 'portrait_metadata');
}

export async function runQaAcceptance(state, { persist, authenticate, cleanupAuth = async () => {}, request = qaRequest, poll = boundedPoll, emit = () => {} }) {
  check(state.status === 'pending', 'run_already_completed');
  const phase = async (name, fn) => { if (state.completed[name]) return; emit({ case: name, status: 'running' }); await fn(); state.completed[name] = true; await persist(); emit({ case: name, status: 'passed' }); };
  const send = (path, input = {}) => {
    const role = input.actor === undefined ? 'organiser' : input.actor;
    if ((!input.method || input.method === 'GET') && /^\/v1\/(player-profile|player-history|player-achievements|player-unlocks|player-portrait)\?/.test(path) && state.players[role]) {
      const url = new URL(path, QA.api); if (url.searchParams.get('playerId') !== state.players[role]) url.searchParams.set('viewerPlayerId', state.players[role]); path = url.pathname + url.search;
    }
    return request(path, { ...input, cookie: role === null ? undefined : state.actors[role].cookie });
  };
  const mutation = createMutationJournal(state, persist, send);
  const write = (name, path, body, actor = 'organiser', method = 'POST', statuses = [200]) => mutation(name, () => ({ path, body, actor, method }), statuses);
  const get = async (path, actor = 'organiser', expected = 200) => { const result = await send(path, { actor }); check(result.status === expected, 'read_status'); return result; };
  const { league: l, season: s, session: x, game: g, zero: zeroId } = state.ids;
  const game = `/v1/games/${g}`, playerPath = playerId => `/v1/owner-player-profile?${q({ playerId })}`;
  const profilePath = playerId => `/v1/player-profile?${q({ leagueId: l, playerId, seasonId: s })}`;
  const achievementsPath = playerId => `/v1/player-achievements?${q({ leagueId: l, playerId, scope: 'season', seasonId: s })}`;
  const fresh = value => value?.freshness?.status === 'ready' && value.freshness.coverage === 'complete' && typeof value.freshness.revision === 'string';
  const confirmed = async (playerId, predicate) => poll(async () => {
    const p = await get(profilePath(playerId)); safePlayerResponse(p.body); privateHeaders(p.headers); if (!fresh(p.body)) return null;
    const a = await get(achievementsPath(playerId)); safePlayerResponse(a.body); privateHeaders(a.headers);
    return fresh(a.body) && p.body.freshness.revision === a.body.freshness.revision ? { p: p.body, a: a.body } : null;
  }, value => value !== null && predicate(value), { progress: () => emit({ case: 'projection', status: 'waiting' }) });
  const count = (a, id) => a.progress?.find(value => value.achievementId === id)?.count;
  const owner = () => state.players.owner, other = () => state.players.other;
  let report;
  try {
    for (const role of ['organiser', 'owner', 'other']) await authenticate(role);
    for (const role of Object.keys(state.players)) if (state.completed[`claim-${role}`]) { const owned = await get(playerPath(state.players[role]), role); check(owned.body.email === state.actors[role].email, 'resumed_player_ownership'); }
    await phase('fixture-source', async () => {
      await write('league', '/v1/leagues', { leagueId: l, name: `QA Player Cards ${state.id}` }, 'organiser', 'POST', [201]);
      await write('season', `/v1/leagues/${l}/seasons`, { seasonId: s, name: 'QA synthetic season', startsOn: state.createdAt.slice(0, 10) }, 'organiser', 'POST', [201]);
      await write('session', `/v1/leagues/${l}/seasons/${s}/sessions`, { sessionId: x, sessionDate: state.createdAt.slice(0, 10) }, 'organiser', 'POST', [201]);
      const created = await write('game', `/v1/leagues/${l}/seasons/${s}/sessions/${x}/games`, { gameId: g, gameStartTs: state.createdAt, thirdLengthMinutes: 20 }, 'organiser', 'POST', [201]);
      check(created.body.gameId === g && /^[A-Z2-9]{8}$/.test(created.body.joinCode), 'fixture_game_identity'); state.joinCode = created.body.joinCode; await persist();
      await write('zero-player', `/v1/league-players?${q({ leagueId: l })}`, { playerId: zeroId, nickname: `QA zero ${state.id.slice(0, 8)}` }, 'organiser', 'POST', [201]);
    });
    await phase('outside-boundary', async () => {
      await get(profilePath(zeroId), 'other', 403); await get(profilePath(zeroId), null, 401);
    });
    for (const role of ['owner', 'other']) await phase(`claim-${role}`, async () => {
      if (!state.proofs[role]) { const secret = randomBytes(32).toString('base64url'); state.proofs[role] = { proofId: randomBytes(18).toString('base64url'), secret, verifier: createHash('sha256').update(secret).digest('hex') }; await persist(); }
      const proof = state.proofs[role];
      const joined = await write(`join-${role}`, `/v1/join/${state.joinCode}`, { nickname: `QA ${role} ${state.id.slice(0, 8)}`, claimProof: { proofId: proof.proofId, verifier: proof.verifier } }, null, 'POST', [201]);
      const playerId = joined.body.player?.playerId; check(typeof playerId === 'string' && playerId.length > 0 && playerId.length < 1024, 'fixture_player_identity'); state.players[role] = playerId; await persist();
      const already = await send(playerPath(playerId), { actor: role });
      if (already.status !== 200) {
        const preview = await send('/v1/player-proofs/preview', { method: 'POST', actor: role, body: { proofId: proof.proofId, secret: proof.secret } });
        check(preview.status === 200 && typeof preview.body.preview?.confirmation === 'string', 'proof_preview');
        const claim = await send(`/v1/player-proofs/claim?${q({ playerId })}`, { method: 'POST', actor: role, body: { proof: { proofId: proof.proofId, secret: proof.secret, confirmation: preview.body.preview.confirmation } } });
        check(claim.status === 200, 'proof_claim');
      }
      await write(`roster-${role}`, `${game}/roster/${encodeURIComponent(playerId)}`, { teamId: role === 'owner' ? 'red' : 'blue' }, 'organiser', 'PUT');
    });
    await phase('ownership-privacy', async () => {
      const privateOwner = await get(playerPath(owner()), 'owner'); privateHeaders(privateOwner.headers); check(privateOwner.body.email === state.actors.owner.email, 'owner_email');
      await get(playerPath(owner()), 'organiser', 403); await get(playerPath(owner()), 'other', 403); await get(playerPath(owner()), null, 401);
      for (const role of ['organiser', 'other']) {
        const denied = await send(playerPath(owner()), { actor: role, method: 'PATCH', key: `${state.id}:denied-${role}`, body: { displayName: 'Must not save', expectedRevision: privateOwner.body.revision } }); check(denied.status === 403, 'nonowner_write');
      }
      const zero = await confirmed(zeroId, value => value.p.career?.played === 0); check(zero.p.latest === null && zero.p.selectedSeasonId === s, 'zero_default_season');
      for (const role of ['owner', 'other']) { const visible = await get(profilePath(owner()), role); safePlayerResponse(visible.body); }
      const catalogue = await get('/v1/achievement-catalogue', 'owner'); check(catalogue.body.ruleVersion === 1 && catalogue.body.achievements?.length === 23, 'catalogue_collection');
    });
    await phase('completed-match', async () => {
      const transition = async (third, action) => {
        const current = (await get(game)).body, segment = current.thirds?.find(value => value.third === third); check(segment, 'third_source');
        if (segment[action === 'start' ? 'startedAt' : 'finishedAt']) return;
        const result = await send(`${game}/thirds/${third}/${action}`, { method: 'POST' }); check(result.status === 200, 'third_transition');
      };
      await transition(1, 'start');
      for (let i = 1; i <= 3; i++) await write(`goal-${i}`, `${game}/goals`, { scoringTeamId: 'red', concedingTeamId: 'blue', scorerPlayerId: owner(), assistPlayerIds: [other()], ownGoal: false }, 'organiser', 'POST', [201]);
      for (let third = 1; third <= 3; third++) {
        if (third !== 1) await transition(third, 'start');
        await transition(third, 'finish');
      }
      await write('finish-game', `${game}/finish`, undefined);
    });
    await phase('initial-statistics', async () => {
      const { p, a } = await confirmed(owner(), value => value.p.season?.goals === 3 && count(value.a, 'hat-trick') === 1);
      check(p.career.goals === 3 && p.latest.goals === 3 && p.season.played === 1 && p.season.wins === 1 && p.season.goalsPerGame === 3, 'initial_totals');
      const sourceGoals = [1, 2, 3].map(i => state.steps[`goal-${i}`].outcome.body.goal);
      check(sourceGoals.every(goal => goal.third === 1 && Number.isInteger(goal.elapsedSeconds) && goal.elapsedSeconds >= 0), 'live_goal_timing');
      state.report.openingGoals = sourceGoals.filter(goal => goal.elapsedSeconds < 120).length;
      state.report.deletedOpeningGoal = sourceGoals[2].elapsedSeconds < 120 ? 1 : 0;
      check(count(a, 'message-sent') === state.report.openingGoals, 'live_timing'); state.report.hatTrickId = a.honours.find(value => value.achievementId === 'hat-trick')?.id; await persist();
      const history = await get(`/v1/player-history?${q({ leagueId: l, playerId: owner(), seasonId: s })}`, 'owner'); safePlayerResponse(history.body); check(history.body.matches?.length === 1 && history.body.matches[0].goals === 3 && history.body.cursor === null, 'match_history');
      const provider = await confirmed(other(), value => value.p.season?.assists === 3); check(count(provider.a, 'master-provider') === 1, 'provider_unlock');
    });
    await phase('correction-revoke', async () => {
      const eventId = state.steps['goal-3'].outcome.body.goal?.eventId; check(typeof eventId === 'string' && eventId.length > 0, 'goal_response_identity');
      await write('delete-goal', `${game}/goals/${encodeURIComponent(eventId)}`, undefined, 'organiser', 'DELETE');
      const { p, a } = await confirmed(owner(), value => value.p.season?.goals === 2 && count(value.a, 'hat-trick') === 0);
      check(p.career.goals === 2 && p.latest.goals === 2 && !a.honours.some(value => value.achievementId === 'hat-trick') && count(a, 'message-sent') === state.report.openingGoals - state.report.deletedOpeningGoal, 'corrected_totals');
    });
    await phase('correction-reinstate', async () => {
      await write('post-completion-goal', `${game}/goals`, { scoringTeamId: 'red', concedingTeamId: 'blue', scorerPlayerId: owner(), assistPlayerIds: [], ownGoal: false }, 'organiser', 'POST', [201]);
      const { a } = await confirmed(owner(), value => value.p.season?.goals === 3 && count(value.a, 'hat-trick') === 1);
      check(count(a, 'message-sent') === state.report.openingGoals - state.report.deletedOpeningGoal && a.honours.find(value => value.achievementId === 'hat-trick')?.id === state.report.hatTrickId, 'reinstated_unlock');
      const unlocks = await get(`/v1/player-unlocks?${q({ leagueId: l, playerId: owner(), scope: 'season', seasonId: s })}`, 'owner'); safePlayerResponse(unlocks.body);
      check(unlocks.body.unlocks?.filter(value => value.achievementId === 'hat-trick').length === 1, 'duplicate_unlock');
    });
    await phase('owner-name', async () => {
      const saved = await mutation('rename', async () => ({ path: playerPath(owner()), method: 'PATCH', actor: 'owner', body: { displayName: `QA renamed ${state.id.slice(0, 8)}`, expectedRevision: (await get(playerPath(owner()), 'owner')).body.revision } })); safePlayerResponse(saved.body);
      const intent = state.steps.rename;
      const replay = await send(intent.request.path, { ...intent.request, key: intent.key }); check(replay.status === 200 && hash(replay.body) === hash(saved.body), 'name_replay');
      const conflict = await send(intent.request.path, { ...intent.request, key: intent.key, body: { ...intent.request.body, displayName: 'Changed intent' } }); check(conflict.status === 409, 'name_key_conflict');
      const stale = await send(intent.request.path, { ...intent.request, key: `${state.id}:stale-name`, body: { ...intent.request.body, displayName: 'Stale write' } }); check(stale.status === 409, 'name_revision_conflict');
      const freshOwner = await get(playerPath(owner()), 'owner'); check(freshOwner.body.displayName === saved.body.displayName, 'name_presentation');
      await poll(async () => (await get(`/v1/league-players?${q({ leagueId: l, query: saved.body.displayName })}`)).body,
        value => value.players?.some(player => player.playerId === owner() && player.nickname === saved.body.displayName), { progress: () => emit({ case: 'directory-name', status: 'waiting' }) });
    });
    for (const [name, colour] of [['portrait-a', [26, 96, 61]], ['portrait-b', [184, 135, 32]]]) await phase(name, async () => {
      const path = `/v1/owner-player-portrait?${q({ playerId: owner() })}`;
      const saved = await mutation(name, async () => ({ path, method: 'PUT', actor: 'owner', body: { expectedRevision: (await get(playerPath(owner()), 'owner')).body.revision, contentType: 'image/png', base64: syntheticPortrait(colour).toString('base64') } })); safePlayerResponse(saved.body); check(saved.body.hasPortrait === true, 'portrait_saved');
      const intent = state.steps[name], replay = await send(path, { ...intent.request, key: intent.key }); check(replay.status === 200 && hash(replay.body) === hash(saved.body), 'portrait_replay');
      const readPath = `/v1/player-portrait?${q({ leagueId: l, playerId: owner() })}`;
      for (const actor of ['owner', 'other', 'organiser']) { const read = await send(readPath, { actor, binary: true }); check(read.status === 200 && read.headers.get('content-type') === 'image/png' && read.headers.get('x-content-type-options') === 'nosniff', 'portrait_read'); privateHeaders(read.headers); assertProcessedPortrait(read.body); state.report[name] = createHash('sha256').update(read.body).digest('hex'); }
      check((await send(readPath, { actor: null })).status === 401, 'portrait_anonymous');
      check((await send(path, { actor: 'other', method: 'PUT', key: `${state.id}:denied-photo`, body: intent.request.body })).status === 403, 'portrait_nonowner');
      check((await send(path, { ...intent.request, key: intent.key, body: { ...intent.request.body, base64: syntheticPortrait([255, 0, 0]).toString('base64') } })).status === 409, 'portrait_key_conflict');
    });
    await phase('portrait-remove', async () => {
      check(state.report['portrait-a'] !== state.report['portrait-b'], 'portrait_replacement');
      const path = `/v1/owner-player-portrait?${q({ playerId: owner() })}`;
      await mutation('remove-portrait', async () => ({ path, method: 'DELETE', actor: 'owner', body: { expectedRevision: (await get(playerPath(owner()), 'owner')).body.revision } }));
      const visible = await get(playerPath(owner()), 'owner'); check(visible.body.hasPortrait === false, 'portrait_removal');
      await get(`/v1/player-portrait?${q({ leagueId: l, playerId: owner() })}`, 'owner', 404);
    });
    report = { status: 'passed', leagueId: l, playerIds: [owner(), other(), zeroId], physicalPortraitCleanup: 'not-verified', browserSharing: 'not-exercised' };
  } finally {
    let failed = false;
    for (const actor of Object.values(state.actors)) {
      if (!actor.cookie) continue;
      try { const result = await request('/v1/auth/logout', { method: 'POST', cookie: actor.cookie }); check(result.status === 204, 'logout_failed'); actor.cookie = null; await persist(); }
      catch { failed = true; }
    }
    try { await cleanupAuth(); } catch { failed = true; }
    if (failed) { state.status = 'pending'; await persist(); throw new QaAcceptanceError('synthetic_logout_incomplete'); }
  }
  state.status = 'complete'; await persist(); emit({ case: 'http-acceptance', status: 'passed' }); return report;
}

export function parseQaArguments(args) {
  const allowed = new Set(['--head', '--run', '--state']); const result = {};
  check(args[0] === '--qa-synthetic', 'explicit_qa_opt_in_required');
  for (let i = 1; i < args.length; i += 2) { check(allowed.has(args[i]) && typeof args[i + 1] === 'string' && !Object.hasOwn(result, args[i]), 'invalid_arguments'); result[args[i]] = args[i + 1]; }
  check(/^[a-f0-9]{40}$/.test(result['--head'] ?? '') && /^\d+$/.test(result['--run'] ?? ''), 'invalid_arguments'); return result;
}
export async function main(args) {
  process.umask(0o077); const options = parseQaArguments(args), head = options['--head'], runId = options['--run'];
  const { verifyQaProvenance } = await import('./player-profile-provenance.mjs');
  const provenance = await verifyQaProvenance({ head, runId, requireFeatures: true });
  check(provenance.tableName === QA.tableName && provenance.region === QA.region, 'provenance_scope');
  const { DynamoDBClient, GetItemCommand } = await import('@aws-sdk/client-dynamodb');
  const { MagicLinkService } = await import('../../api/dist/auth/magic-link.js');
  const client = new DynamoDBClient({ region: QA.region, profile: QA.profile });
  const path = options['--state'] ? resolve(options['--state']) : join(await mkdtemp(join(tmpdir(), '3fc-profile-qa-')), 'state.json');
  let state;
  try { state = await readPrivateState(path, head, runId); } catch (error) { if (error?.code !== 'ENOENT') throw error; state = createQaState(head, runId); await writePrivateState(path, state); }
  const persist = () => writePrivateState(path, state);
  // Log only the recovery file path, never its contents or a credential URL.
  console.log(JSON.stringify({ event: 'qa-player-profile', statePath: path, status: 'started' }));
  async function authenticate(role) {
    const actor = state.actors[role];
    if (actor.cookie) { const current = await qaRequest('/v1/auth/session', { cookie: actor.cookie }); if (current.status === 200 && current.body.authenticated && current.body.session?.email === actor.email) return; actor.cookie = null; await persist(); }
    check(actor.tokens.length < 40, 'synthetic_auth_retry_limit');
    const tokenId = `qa-player-${randomUUID()}`, secret = randomBytes(32).toString('base64url');
    actor.tokens.push({ tokenId, email: actor.email }); await persist();
    const service = new MagicLinkService(client, { async sendMagicLink() { return {}; } }, { tableName: QA.tableName, appBaseUrl: QA.site, callbackPath: '/auth/callback', tokenTtlSeconds: 300, sessionTtlSeconds: 300 }, undefined,
      { tokenId: () => tokenId, tokenSecret: () => secret, sessionId: () => randomUUID() });
    try {
      await service.start(actor.email);
      const result = await qaRequest('/v1/auth/magic/complete', { method: 'POST', body: { token: `${tokenId}.${secret}` } });
      check(result.status === 200, 'magic_completion'); actor.cookie = sessionCookie(result.headers); await persist();
    } catch { throw new QaAcceptanceError('synthetic_auth_failed'); }
  }
  async function cleanupAuth() {
    // Recover a session created by an ambiguously acknowledged completion.
    // Only token IDs journalled before this run's conditional creation are read.
    let failed = false;
    for (const actor of Object.values(state.actors)) for (const token of actor.tokens) {
      try {
        const { Item: item } = await client.send(new GetItemCommand({ TableName: QA.tableName, Key: { pk: { S: `AUTH_MAGIC#${token.tokenId}` }, sk: { S: 'METADATA' } }, ConsistentRead: true }), { abortSignal: AbortSignal.timeout(15_000) });
        if (!item) continue;
        check(item.email?.S === actor.email && item.entityType?.S === 'magicToken', 'auth_cleanup_ownership');
        if (!item.sessionId?.S) continue; // An unused token expires after five minutes.
        check(item.usedAt?.S && !/[\s\r\n;]/.test(item.sessionId.S), 'auth_cleanup_state');
        const { Item: session } = await client.send(new GetItemCommand({ TableName: QA.tableName, Key: { pk: { S: `AUTH_SESSION#${item.sessionId.S}` }, sk: { S: 'METADATA' } }, ConsistentRead: true }), { abortSignal: AbortSignal.timeout(15_000) });
        if (!session) continue;
        check(session.email?.S === actor.email && session.entityType?.S === 'session', 'auth_cleanup_ownership');
        const result = await qaRequest('/v1/auth/logout', { method: 'POST', cookie: encodeURIComponent(item.sessionId.S) }); check(result.status === 204, 'auth_cleanup_logout');
        const verified = await qaRequest('/v1/auth/session', { cookie: encodeURIComponent(item.sessionId.S) });
        check(verified.status === 401 || verified.status === 200 && verified.body.authenticated === false, 'auth_cleanup_session_active');
      } catch { failed = true; }
    }
    if (failed) throw new QaAcceptanceError('synthetic_logout_incomplete');
  }
  try {
    // A final provenance read may fail after all writes and cleanup completed.
    // Resume that evidence-only boundary without generating accounts or matches.
    let report;
    if (state.status === 'complete') { await cleanupAuth(); report = { status: 'passed', leagueId: state.ids.league, playerIds: [state.players.owner, state.players.other, state.ids.zero], physicalPortraitCleanup: 'not-verified', browserSharing: 'not-exercised' }; }
    else report = await runQaAcceptance(state, { persist, authenticate, cleanupAuth, emit: event => console.log(JSON.stringify({ event: 'qa-player-profile', ...event })) });
    await provenance.recheck();
    console.log(JSON.stringify({ event: 'qa-player-profile', ...report }));
  } finally { client.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => {
  console.error(JSON.stringify({ event: 'qa-player-profile', status: 'failed', code: error instanceof QaAcceptanceError ? error.code : 'unexpected_failure' })); process.exitCode = 1;
});
