import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import type { PlayerClient } from '../ui/player-client.js';
import { createPlayerClient, PlayerClientError } from '../ui/player-client.js';
import { mountPlayerProfile } from '../ui/player-profile.js';
import { appearance, performance } from './player-profile-fixtures.js';

const html = `<body><div id="account-actions" hidden><button id="sign-out" disabled>Sign out</button><p id="sign-out-status"></p></div><main id="player-profile">
<p id="player-status"></p><a id="player-signin" hidden>Sign in</a><button id="player-retry">Retry</button><div id="player-access"></div><section id="player-content" hidden>
<h1 id="player-name"></h1><p id="player-league"></p><div id="player-avatar"></div><div data-ui="field"><select id="player-season"></select></div>
<fieldset id="player-period"><input type="radio" name="period" value="season" checked><input type="radio" name="period" value="career"><input type="radio" name="period" value="last"></fieldset>
<h2 id="player-period-title"></h2><dl id="player-stats"></dl><div id="player-latest"></div><ol id="player-history-list"></ol><p id="player-history-status"></p><button id="player-history-more">Load more</button><a id="player-edit">Edit</a></section></main></body>`;
function fixture(overrides: Partial<PlayerClient> = {}, search = '') {
  const dom = new JSDOM(html, { url: `https://3fc.football/player?leagueId=league&playerId=player%2Froot${search}` });
  const client: PlayerClient = { ...createPlayerClient({ baseUrl: dom.window.location.origin, fetch: async () => { throw new Error('Unexpected network'); } }),
    session: async () => ({ authenticated: true, session: { sessionId: 'session', email: 'private@example.com', subject: 'subject' } }),
    performance: async context => ({ ...performance, ...(context.seasonId ? { selectedSeasonId: context.seasonId } : {}) }),
    history: async (_context, page = {}) => ({ matches: [{ ...appearance, seasonId: page.seasonId ?? appearance.seasonId }], cursor: null, freshness: performance.freshness }), portrait: async () => null, ...overrides };
  const root = dom.window.document.getElementById('player-profile')!;
  const mounted = mountPlayerProfile(root, client);
  return { dom, root, client, mounted, close() { mounted.destroy(); dom.window.close(); } };
}
async function settle(check: () => boolean) { for (let i = 0; i < 40; i++) { if (check()) return; await new Promise<void>(resolve => setImmediate(resolve)); } assert.fail('Expected UI state did not settle'); }
function period(f: ReturnType<typeof fixture>, value: string) { const radio = f.root.querySelector<HTMLInputElement>(`input[value="${value}"]`)!; radio.checked = true; radio.dispatchEvent(new f.dom.window.Event('change', { bubbles: true })); }

test('profile opens on supplied season, shows authoritative grid and team totals, and keeps account email absent', async () => {
  const queries: string[] = [], f = fixture({ performance: async input => { queries.push(input.seasonId ?? 'default'); return { ...performance, selectedSeasonId: input.seasonId ?? 'winter' }; } }, '&seasonId=summer');
  try {
    await f.mounted.ready; assert.deepEqual(queries, ['summer']); assert.equal(f.root.querySelector('#player-name')?.textContent, '<Xavier>'); assert.equal(f.root.querySelector('xavier'), null);
    assert.match(f.root.querySelector('#player-stats')!.textContent!, /Played1Goals2Assists1Wins1Draws0Own goals0Goals \/ game2/);
    assert.match(f.root.querySelector('#player-latest dl')!.textContent!, /Scored4Conceded1/);
    assert.equal(f.root.textContent?.includes('private@example.com'), false); assert.equal(f.root.querySelector<HTMLAnchorElement>('#player-edit')!.hidden, false);
    period(f, 'last'); await settle(() => f.root.querySelector('#player-stats')?.textContent?.includes('ResultWin') === true);
    assert.equal(f.root.querySelector<HTMLElement>('#player-season')!.closest<HTMLElement>('[data-ui="field"]')!.hidden, true); assert.equal(f.root.querySelector<HTMLSelectElement>('#player-season')!.value, 'summer');
    period(f, 'season'); await settle(() => f.root.querySelector<HTMLElement>('#player-season')!.closest<HTMLElement>('[data-ui="field"]')!.hidden === false); assert.equal(f.root.querySelector<HTMLSelectElement>('#player-season')!.value, 'summer');
    period(f, 'last'); await settle(() => f.root.querySelectorAll('#player-stats dt').length === 4);
    assert.equal(f.root.querySelectorAll('#player-stats dt').length, 4); assert.equal(f.root.querySelector<HTMLAnchorElement>('#player-history-list a')?.getAttribute('href'), '/games/game%2Fone');
  } finally { f.close(); }
});

test('history loads exactly one page per click and career drops the season filter', async () => {
  const calls: Array<{ seasonId?: string; cursor?: string }> = [];
  const f = fixture({ history: async (_context, page = {}) => { calls.push(page); return { matches: [{ ...appearance, gameId: page.cursor ? 'second' : 'first' }], cursor: page.cursor ? null : 'next', freshness: performance.freshness }; } });
  try {
    await f.mounted.ready; assert.deepEqual(calls, [{ seasonId: 'winter' }]);
    f.root.querySelector<HTMLButtonElement>('#player-history-more')!.click(); await settle(() => f.root.querySelectorAll('#player-history-list li').length === 2);
    assert.deepEqual(calls[1], { seasonId: 'winter', cursor: 'next' });
    period(f, 'career'); await settle(() => calls.length === 3 && f.root.querySelectorAll('#player-history-list li').length === 1); assert.deepEqual(calls[2], {});
  } finally { f.close(); }
});

test('a changed projection never appends mixed history and offers an explicit refresh', async () => {
  const f = fixture({ history: async (_context, page = {}) => ({ matches: [appearance], cursor: page.cursor ? null : 'next', freshness: { ...performance.freshness, revision: page.cursor ? 'revision-b' : 'revision-a' } }) });
  try {
    await f.mounted.ready; f.root.querySelector<HTMLButtonElement>('#player-history-more')!.click();
    await settle(() => f.root.querySelector('#player-status')!.textContent!.includes('consistent view'));
    assert.equal(f.root.querySelector('#player-history-list')!.children.length, 0); assert.equal(f.root.querySelector<HTMLElement>('#player-content')!.hidden, true); assert.equal(f.root.querySelector<HTMLButtonElement>('#player-retry')!.hidden, false);
  } finally { f.close(); }
});

test('unavailable history stays unknown and a confirmed zero season remains zero', async () => {
  const f = fixture({ performance: async () => ({ ...performance, season: null, career: null, latest: null, freshness: { status: 'updating', coverage: 'unknown', revision: null, computedAt: null }, capabilities: { editProfile: false, achievements: false } }), history: async () => ({ matches: null, cursor: null, freshness: { status: 'updating', coverage: 'unknown', revision: null, computedAt: null } }) });
  try {
    await f.mounted.ready; assert.equal(f.root.querySelectorAll('#player-stats dd').length, 0); assert.match(f.root.querySelector('#player-status')!.textContent!, /unavailable/); assert.equal(f.root.querySelector<HTMLAnchorElement>('#player-edit')!.hidden, true);
  } finally { f.close(); }
  const zero = { played: 0, goals: 0, assists: 0, ownGoals: 0, wins: 0, draws: 0, losses: 0, goalsPerGame: 0 };
  const g = fixture({ performance: async () => ({ ...performance, season: zero, career: zero, latest: null }), history: async () => ({ matches: [], cursor: null, freshness: performance.freshness }) });
  try { await g.mounted.ready; assert.equal(g.root.querySelector('#player-stats dd')!.textContent, '0'); assert.match(g.root.querySelector('#player-history-status')!.textContent!, /No completed/); } finally { g.close(); }
});

test('participant discovery is bounded and only passes verified server hints to the profile request', async () => {
  const accessCalls: Array<string | undefined> = [], hints: Array<string | undefined> = [];
  const f = fixture({ performance: async context => { hints.push(context.viewerPlayerId); if (!context.viewerPlayerId) throw new PlayerClientError(403, 'forbidden', 'Forbidden'); return performance; }, access: async (_league, page = {}) => {
    accessCalls.push(page.cursor); return { leagueId: 'league', hasLeagueAcl: false, players: page.cursor ? [{ playerId: 'verified', displayName: 'Owner' }] : [], cursor: page.cursor ? null : 'more', complete: Boolean(page.cursor) };
  } });
  try {
    await f.mounted.ready; assert.deepEqual(accessCalls, [undefined]); f.root.querySelector<HTMLButtonElement>('#player-access button')!.click();
    await settle(() => f.root.querySelector('#player-name')!.textContent === '<Xavier>'); assert.deepEqual(accessCalls, [undefined, 'more']); assert.deepEqual(hints, [undefined, 'verified']);
  } finally { f.close(); }
});

test('signout and a changed account clear content and reject late profile responses', async () => {
  let finish!: (value: typeof performance) => void, started = false;
  const f = fixture({ performance: async () => { started = true; return new Promise(resolve => { finish = resolve; }); } });
  try {
    await settle(() => started); f.dom.window.dispatchEvent(new f.dom.window.Event('threefc:player-proof-cleared')); finish(performance); await f.mounted.ready;
    assert.equal(f.root.querySelector('#player-name')!.textContent, ''); assert.equal(f.root.querySelector<HTMLElement>('#player-content')!.hidden, true);
  } finally { f.close(); }
  let sessions = 0;
  const g = fixture({ session: async () => ({ authenticated: true, session: { sessionId: ++sessions > 1 ? 'different' : 'original', email: 'private@example.com' } }) });
  try { await g.mounted.ready; assert.equal(g.root.querySelector('#player-name')!.textContent, ''); assert.match(g.root.querySelector('#player-status')!.textContent!, /sign-in changed/); } finally { g.close(); }
});

test('unavailable match page does not become a confirmed empty history and sign-in stays actionable', async () => {
  const f = fixture({ history: async () => ({ matches: null, cursor: null, freshness: { ...performance.freshness, status: 'updating', coverage: 'unknown' } }) });
  try { await f.mounted.ready; assert.match(f.root.querySelector('#player-history-status')!.textContent!, /unavailable/); assert.doesNotMatch(f.root.querySelector('#player-history-status')!.textContent!, /No completed/); } finally { f.close(); }
  const g = fixture({ session: async () => ({ authenticated: false, session: null }) });
  try { await g.mounted.ready; const link = g.root.querySelector<HTMLAnchorElement>('#player-signin')!; assert.equal(link.hidden, false); assert.equal(new URL(link.href).searchParams.get('returnTo'), '/player?leagueId=league&playerId=player%2Froot'); } finally { g.close(); }
});
