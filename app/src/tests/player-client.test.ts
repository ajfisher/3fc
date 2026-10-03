import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { bindPlayerAccount, createPlayerClient, parsePlayerHistory, parsePlayerPerformance, playerHref, PlayerClientError } from '../ui/player-client.js';
import { appearance, performance, totals } from './player-profile-fixtures.js';

test('browser profile parsing keeps unavailable distinct from zero and removes extra private fields', () => {
  const parsed = parsePlayerPerformance({ ...performance, email: 'private@example.com', player: { ...performance.player, email: 'secret' } });
  assert.deepEqual(parsed, performance); assert.equal(JSON.stringify(parsed).includes('secret'), false);
  assert.equal(parsePlayerPerformance({ ...performance, career: null }).career, null);
  assert.throws(() => parsePlayerPerformance({ ...performance, career: { ...totals, goalsPerGame: 0 } }), PlayerClientError);
  assert.throws(() => parsePlayerPerformance({ ...performance, selectedSeasonId: 'unknown' }), PlayerClientError);
  assert.throws(() => parsePlayerHistory({ matches: null, cursor: 'cursor', freshness: performance.freshness }), PlayerClientError);
  assert.throws(() => parsePlayerHistory({ matches: [appearance, appearance], cursor: null, freshness: performance.freshness }), PlayerClientError);
});

test('typed client encodes opaque IDs, uses session cookies and freezes mutation receipt inputs', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const details = { playerId: 'player/root', displayName: 'Xavier', hasPortrait: false, revision: 'a'.repeat(64) };
  const client = createPlayerClient({ baseUrl: 'https://3fc.football', fetch: async (url, init) => {
    calls.push({ url: String(url), init }); return new Response(JSON.stringify(String(url).includes('owner-') ? { ...details, email: 'private@example.com' } : performance), { status: 200 });
  } });
  const context = { leagueId: 'league', playerId: 'name/#?& email@example.com', viewerPlayerId: 'viewer/one' };
  await client.performance(context);
  assert.equal(new URL(calls[0].url).searchParams.get('playerId'), context.playerId); assert.equal(calls[0].init?.credentials, 'include'); assert.equal(calls[0].init?.cache, 'no-store');
  const input = { displayName: 'Xavier', expectedRevision: 'a'.repeat(64), idempotencyKey: 'fixed-key' };
  assert.deepEqual(await client.rename(context.playerId, input), details);
  await client.rename(context.playerId, input);
  assert.deepEqual(calls[1].init?.body, calls[2].init?.body); assert.equal((calls[1].init?.headers as Record<string, string>)['Idempotency-Key'], 'fixed-key');
  assert.equal(JSON.parse(String(calls[1].init?.body)).idempotencyKey, undefined);
  assert.equal(new URL(playerHref(context, 'season/#'), 'https://3fc.football').searchParams.get('seasonId'), 'season/#');
});

test('client uses fixed safe errors and validates response league and history season', async () => {
  const denied = createPlayerClient({ baseUrl: 'https://3fc.football', fetch: async () => new Response(JSON.stringify({ message: 'private@example.com', code: 'player_profile_forbidden' }), { status: 403 }) });
  await assert.rejects(denied.performance({ leagueId: 'league', playerId: 'p' }), error => error instanceof PlayerClientError && error.status === 403 && !error.message.includes('@'));
  const wrong = createPlayerClient({ baseUrl: 'https://3fc.football', fetch: async url => new Response(JSON.stringify(String(url).includes('history') ? { matches: [appearance], cursor: null, freshness: performance.freshness } : performance)) });
  await assert.rejects(wrong.performance({ leagueId: 'other', playerId: 'p' }), PlayerClientError);
  await assert.rejects(wrong.history({ leagueId: 'league', playerId: 'p' }, { seasonId: 'summer' }), PlayerClientError);
});

test('client aborts requests with its caller and a valid missing portrait stays empty', async () => {
  const abort = new AbortController(); abort.abort(); let aborted = false;
  const client = createPlayerClient({ baseUrl: 'https://3fc.football', fetch: async (_url, init) => { aborted = init?.signal?.aborted === true; throw new DOMException('Aborted', 'AbortError'); } });
  await assert.rejects(client.session(abort.signal)); assert.equal(aborted, true);
  const empty = createPlayerClient({ baseUrl: 'https://3fc.football', fetch: async () => new Response(JSON.stringify({ error: 'portrait_not_found' }), { status: 404 }) });
  assert.equal(await empty.portrait({ leagueId: 'league', playerId: 'player' }), null);
});

test('account controls become available for a newly verified session after signout and controller remount', async () => {
  const dom = new JSDOM('<div id="account-actions"><button id="sign-out">Sign out</button><p id="sign-out-status"></p></div>', { url: 'https://3fc.football/player' });
  const button = dom.window.document.getElementById('sign-out') as HTMLButtonElement;
  let invalidated = 0;
  const client = { logout: async () => {} };
  const first = bindPlayerAccount(dom.window.document, client, () => { invalidated++; });
  try {
    first.setAuthenticated(true); button.click();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(invalidated, 1); assert.equal(button.hidden, true); first.destroy();
    const next = bindPlayerAccount(dom.window.document, client, () => {});
    try { next.setAuthenticated(true); assert.equal(button.hidden, false); assert.equal(button.disabled, false); } finally { next.destroy(); }
  } finally { first.destroy(); dom.window.close(); }
});
