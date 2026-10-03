import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { ACHIEVEMENT_DEFINITIONS } from '@3fc/contracts';
import { achievementNotes, achievementProgressLabel, mountAchievementGallery, parseGalleryLocation } from '../ui/achievement-gallery.js';
import { createPlayerClient, parseAchievementCatalogue, PlayerClientError, type PlayerClient } from '../ui/player-client.js';
import { catalogueResponse, personal, unlock } from './achievement-gallery-fixtures.js';
import { performance } from './player-profile-fixtures.js';
const html = `<body><main id="achievement-gallery"><p id="achievements-status"></p><button id="achievements-retry" hidden>Retry</button><a id="achievements-signin" hidden>Sign in</a><div id="achievements-access"></div><section id="achievements-content" hidden><h1 id="achievements-player"></h1><p id="achievements-context"></p><a id="achievements-back">Back</a><div id="achievements-personal-controls"><fieldset id="achievements-scope"><input type="radio" name="scope" value="season" checked><input type="radio" name="scope" value="career"></fieldset><div id="achievements-season-field"><select id="achievements-season"></select></div></div><input id="achievement-search"><select id="achievement-rarity"><option>All</option><option>Common</option><option>Rare</option><option>Legendary</option><option>Epic</option></select><div id="achievement-earned-field"><select id="achievement-earned"><option value="all">All</option><option value="earned">Earned</option><option value="to-unlock">To unlock</option></select></div><button id="achievement-reset">Reset</button><p id="achievement-count"></p><div id="achievement-grid"></div><p id="achievement-empty" hidden>No matches</p></section><dialog id="achievement-detail"><button id="achievement-detail-close">Close</button><div id="achievement-detail-art"></div><h2 id="achievement-detail-title"></h2><p id="achievement-detail-rarity"></p><p id="achievement-detail-rule"></p><ul id="achievement-detail-conditions"></ul><div id="achievement-detail-progression"></div><section id="achievement-detail-personal"><p id="achievement-detail-progress"></p><p id="achievement-detail-first"></p><p id="achievement-detail-highest"></p><ol id="achievement-detail-unlocks"></ol><button id="achievement-detail-more">More</button><p id="achievement-detail-status"></p></section></dialog></main></body>`;
function fixture(overrides: Partial<PlayerClient> = {}, query = '?leagueId=league&playerId=player%2Froot') {
  const dom = new JSDOM(html, { url: `https://3fc.football/achievements${query}` }), doc = dom.window.document;
  const dialog = doc.getElementById('achievement-detail') as HTMLDialogElement;
  dialog.showModal = () => { dialog.setAttribute('open', ''); };
  dialog.close = () => { dialog.removeAttribute('open'); dialog.dispatchEvent(new dom.window.Event('close')); };
  const client: PlayerClient = { ...createPlayerClient({ baseUrl: dom.window.location.origin, fetch: async () => { throw new Error('Unexpected request'); } }),
    session: async () => ({ authenticated: true, session: { sessionId: 'session', email: 'private@example.com' } }), catalogue: async () => parseAchievementCatalogue(catalogueResponse),
    performance: async input => ({ ...performance, selectedSeasonId: input.seasonId ?? 'winter' }), achievements: async (_context, scope) => personal(scope), unlocks: async () => ({ unlocks: [unlock('goal')], cursor: null, freshness: performance.freshness }), ...overrides };
  const root = doc.getElementById('achievement-gallery')!, mounted = mountAchievementGallery(root, client);
  const get = <T extends HTMLElement>(id: string) => doc.getElementById(id) as T;
  return { dom, root, get, mounted, close() { mounted.destroy(); dom.window.close(); } };
}
async function settle(check: () => boolean) { for (let i = 0; i < 40; i++) { if (check()) return; await new Promise<void>(resolve => setImmediate(resolve)); } assert.fail('UI did not settle'); }
function change(f: ReturnType<typeof fixture>, id: string, value: string, event = 'change') { const input = f.get<HTMLInputElement>(id); input.value = value; input.dispatchEvent(new f.dom.window.Event(event, { bubbles: true })); }

test('all 23 rule notes explain counting and timing while preserving exact thresholds and appearance streaks', () => {
  for (const definition of ACHIEVEMENT_DEFINITIONS) assert.ok(achievementNotes(definition.id).length > 1, definition.id);
  assert.match(achievementNotes('message-sent').join(' '), /not including, 02:00/);
  assert.match(achievementNotes('clutch').join(' '), /60 seconds.*stoppage/);
  assert.match(achievementNotes('defence').join(' '), /less than 2.*either opponent/);
  assert.match(achievementNotes('on-fire').join(' '), /five|5 consecutive/);
  assert.match(achievementNotes('on-fire').join(' '), /Missed fixtures do not break/);
  assert.match(achievementNotes('hat-trick').join(' '), /at most one.*per match/);
  assert.equal(achievementProgressLabel(null), 'Progress unavailable');
  assert.match(achievementProgressLabel({ ...personal().progress![0], assessability: 'partial', count: 0 }), /At least 0 confirmed.*History incomplete/);
});

test('contextless collection renders all artwork without personal claims; search rarity and reset combine', async () => {
  const f = fixture({}, '');
  try {
    await f.mounted.ready; assert.equal(f.root.querySelectorAll('[data-badge]').length, 23); assert.equal(f.get('achievement-earned-field').hidden, true); assert.equal(f.get('achievements-personal-controls').hidden, true);
    change(f, 'achievement-search', 'goal', 'input'); const found = f.root.querySelectorAll('[data-badge]').length; assert.ok(found > 1 && found < 23);
    change(f, 'achievement-rarity', 'Common'); assert.deepEqual([...f.root.querySelectorAll<HTMLElement>('[data-badge]')].map(tile => tile.dataset.badge), ['goal', 'assist']);
    f.get<HTMLButtonElement>('achievement-reset').click(); assert.equal(f.root.querySelectorAll('[data-badge]').length, 23);
    assert.equal(f.root.textContent?.includes('private@example.com'), false);
    f.get<HTMLButtonElement>('achievement-open-goal').click(); assert.equal(f.get('achievement-detail-personal').hidden, true);
  } finally { f.close(); }
});

test('personal gallery honors supplied season, earned filters and dialog focus without replacing filter state', async () => {
  const scopes: string[] = [], f = fixture({ achievements: async (_context, scope) => { scopes.push(scope.scope === 'season' ? scope.seasonId : 'career'); return personal(scope, { goal: 5 }); } }, '?leagueId=league&playerId=player%2Froot&seasonId=summer');
  try {
    await f.mounted.ready; assert.deepEqual(scopes, ['summer']); assert.match(f.get('achievements-context').textContent!, /Summer/);
    change(f, 'achievement-earned', 'earned'); assert.equal(f.root.querySelectorAll('[data-badge]').length, 1);
    const button = f.get<HTMLButtonElement>('achievement-open-goal'); button.focus(); button.click();
    assert.match(f.get('achievement-detail-first').textContent!, /First unlock/); assert.match(f.get('achievement-detail-highest').textContent!, /★ 2/);
    f.get<HTMLDialogElement>('achievement-detail').dispatchEvent(new f.dom.window.Event('cancel')); f.get<HTMLDialogElement>('achievement-detail').close();
    assert.equal(f.dom.window.document.activeElement, button); assert.equal(f.get<HTMLSelectElement>('achievement-earned').value, 'earned'); assert.equal(f.get<HTMLDialogElement>('achievement-detail').open, false);
    const career = f.root.querySelector<HTMLInputElement>('input[value=career]')!; career.checked = true; career.dispatchEvent(new f.dom.window.Event('change', { bubbles: true }));
    await settle(() => scopes.length === 2 && f.get('achievements-season-field').hidden); assert.equal(scopes[1], 'career'); assert.equal(new URL(f.dom.window.location.href).searchParams.has('seasonId'), false);
  } finally { f.close(); }
});

test('unknown personal progress remains unavailable and partial progress is a confirmed lower bound', async () => {
  const f = fixture({ achievements: async (_context, scope) => ({ ...personal(scope), progress: null, honours: null, firstUnlocks: null, latestUnlocks: null }) });
  try {
    await f.mounted.ready; assert.match(f.get('achievement-grid').textContent!, /Progress unavailable/); assert.doesNotMatch(f.get('achievement-grid').textContent!, /0 confirmed/);
    change(f, 'achievement-earned', 'to-unlock'); assert.equal(f.root.querySelectorAll('[data-badge]').length, 0); assert.match(f.get('achievement-count').textContent!, /Unconfirmed achievements remain in All/); change(f, 'achievement-earned', 'all'); f.get<HTMLButtonElement>('achievement-open-goal').click(); assert.match(f.get('achievement-detail-first').textContent!, /unavailable/);
  } finally { f.close(); }
  const g = fixture({ achievements: async (_context, scope) => { const result = personal(scope); result.progress![0].assessability = 'partial'; return result; } });
  try { await g.mounted.ready; assert.match(g.get('achievement-grid').textContent!, /At least 1 confirmed/); assert.match(g.get('achievements-status').textContent!, /cannot be fully assessed/); } finally { g.close(); }
  const h = fixture({ achievements: async (_context, scope) => { const result = personal(scope, {}); result.progress![0].assessability = 'partial'; return result; } });
  try { await h.mounted.ready; change(h, 'achievement-earned', 'to-unlock'); assert.equal(h.root.querySelectorAll('[data-badge]').length, 22); assert.equal(h.root.querySelector('[data-badge=goal]'), null); } finally { h.close(); }

});

test('detail loads bounded global pages explicitly even when first page has no matching badge', async () => {
  const cursors: Array<string | undefined> = [], f = fixture({ unlocks: async (_context, scope, page = {}) => { cursors.push(page.cursor); return { unlocks: [unlock(page.cursor ? 'goal' : 'wins', 1, scope)], cursor: page.cursor ? null : 'next', freshness: performance.freshness }; } });
  try {
    await f.mounted.ready; f.get<HTMLButtonElement>('achievement-open-goal').click(); assert.equal(cursors.length, 0);
    f.get<HTMLButtonElement>('achievement-detail-more').click(); await settle(() => cursors.length === 1 && !f.get<HTMLButtonElement>('achievement-detail-more').disabled);
    assert.equal(f.get('achievement-detail-unlocks').children.length, 0); assert.match(f.get('achievement-detail-status').textContent!, /More history is available/); assert.equal(f.get('achievement-detail-more').hidden, false);
    f.get<HTMLButtonElement>('achievement-detail-more').click(); await settle(() => f.get('achievement-detail-unlocks').children.length === 1);
    assert.deepEqual(cursors, [undefined, 'next']); assert.equal(f.get('achievement-detail-more').hidden, true);
  } finally { f.close(); }
});

test('correction during unlock paging clears obsolete data and retains filters for retry', async () => {
  const f = fixture({ unlocks: async () => ({ unlocks: [unlock('goal')], cursor: null, freshness: { ...performance.freshness, revision: 'different' } }) });
  try {
    await f.mounted.ready; change(f, 'achievement-search', 'goal', 'input'); f.get<HTMLButtonElement>('achievement-open-goal').click(); f.get<HTMLButtonElement>('achievement-detail-more').click();
    await settle(() => f.get('achievements-status').textContent!.includes('consistent view'));
    assert.equal(f.get<HTMLDialogElement>('achievement-detail').open, false); assert.equal(f.get('achievement-grid').children.length, 0); assert.equal(f.get<HTMLInputElement>('achievement-search').value, 'goal'); assert.equal(f.get('achievements-retry').hidden, false);
  } finally { f.close(); }
});

test('auth revocation clears detail and late personal responses, and invalid gallery contexts fail closed', async () => {
  let finish!: (value: ReturnType<typeof personal>) => void, started = false;
  const f = fixture({ achievements: async () => { started = true; return new Promise(resolve => { finish = resolve; }); } });
  try {
    await settle(() => started); f.dom.window.dispatchEvent(new f.dom.window.Event('threefc:player-proof-invalidated')); finish(personal()); await f.mounted.ready;
    assert.equal(f.get('achievement-grid').children.length, 0); assert.equal(f.get('achievements-player').textContent, ''); assert.equal(f.get('achievements-signin').hidden, false);
  } finally { f.close(); }
  for (const query of ['?playerId=p', '?scope=career', '?leagueId=l&playerId=p&scope=career&seasonId=s', '?achievementId=unknown', '?achievementId=goal&achievementId=played', '?email=private'])
    assert.throws(() => parseGalleryLocation(new URL(`https://3fc.football/achievements${query}`)), PlayerClientError);
  assert.equal(parseGalleryLocation(new URL('https://3fc.football/achievements?achievementId=goal')).achievementId, 'goal');
});

test('partial projection coverage downgrades zero class progress and never claims complete unlock history', async () => {
  const f = fixture({ achievements: async (_context, scope) => ({ ...personal(scope, {}), freshness: { ...performance.freshness, status: 'updating', coverage: 'partial' } }),
    unlocks: async () => ({ unlocks: [], cursor: null, freshness: { ...performance.freshness, coverage: 'partial' } }) });
  try {
    await f.mounted.ready; assert.match(f.get('achievements-status').textContent!, /updating|unavailable/);
    assert.match(f.get('achievement-grid').textContent!, /At least 0 confirmed/);
    change(f, 'achievement-earned', 'to-unlock'); assert.equal(f.root.querySelectorAll('[data-badge]').length, 0);
    change(f, 'achievement-earned', 'all'); f.get<HTMLButtonElement>('achievement-open-goal').click(); f.get<HTMLButtonElement>('achievement-detail-more').click();
    await settle(() => f.get('achievement-detail-status').textContent!.includes('history is incomplete'));
    assert.doesNotMatch(f.get('achievement-detail-status').textContent!, /No recorded|All recorded/);
  } finally { f.close(); }
  const g = fixture({ achievements: async (_context, scope) => ({ ...personal(scope), freshness: { ...performance.freshness, coverage: 'unknown' } }) });
  try { await g.mounted.ready; assert.match(g.get('achievement-grid').textContent!, /Progress unavailable/); assert.doesNotMatch(g.get('achievement-grid').textContent!, /0 confirmed/); g.get<HTMLButtonElement>('achievement-open-goal').click(); assert.equal(g.get('achievement-detail-first').textContent, 'First unlock date unavailable.'); } finally { g.close(); }
});
