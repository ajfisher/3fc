import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { ACHIEVEMENT_DEFINITIONS, type PlayerAchievements } from '@3fc/contracts';
import { mountClubCard, rasterizeClubCard, type ClubCardSnapshot } from '../ui/club-card.js';
import { PlayerClientError } from '../ui/player-client.js';
import { performance } from './player-profile-fixtures.js';
const markup = `<button id="opener">Card</button><dialog id="club-card-dialog"><h2 id="club-card-title"></h2><button id="club-card-close">Close</button><div id="club-card-art"></div><button id="club-card-flip">Flip</button><button id="club-card-share">Share</button><button id="club-card-download">Download</button><button id="club-card-retry">Retry</button><p id="club-card-status"></p><ul id="club-card-honours-links"></ul><a id="club-card-gallery">Collection</a></dialog>`;
const awards: PlayerAchievements = { leagueId: 'league', playerId: 'player/root', scope: 'season', seasonId: 'winter', progress: [], honours: [], firstUnlocks: [], latestUnlocks: [], freshness: performance.freshness };
async function settle() { for (let i = 0; i < 12; i++) await new Promise<void>(resolve => setImmediate(resolve)); }
function fixture(manualTimers = false) {
  const dom = new JSDOM(markup, { url: 'https://3fc.football/player', pretendToBeVisual: true }), d = dom.window.document;
  let clock = 1000, timerId = 0;
  const timers = new Map<number, { due: number; callback: () => void }>(), scheduled: Array<() => void> = [];
  if (manualTimers) Object.assign(dom.window, {
    setTimeout(callback: () => void, delay = 0) { const id = ++timerId; timers.set(id, { due: clock + delay, callback }); scheduled.push(callback); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  });
  Object.assign(dom.window.HTMLDialogElement.prototype, { showModal(this: HTMLDialogElement) { this.open = true; }, close(this: HTMLDialogElement) { this.open = false; } });
  let snapshot: ClubCardSnapshot | null = { context: { leagueId: 'league', playerId: 'alias', viewerPlayerId: 'viewer' }, performance: structuredClone(performance), period: 'season', portraitDataUrl: null };
  let session = { authenticated: true, session: { sessionId: 's', subject: 'account', email: 'private@example.test' } }, sessionFailure: Error | null = null;
  let prepare: (svg: string) => Promise<Blob> = async () => new dom.window.Blob(['png'], { type: 'image/png' });
  let readPerformance = async () => structuredClone(snapshot!.performance), reads = 0;
  let getAwards = async (): Promise<PlayerAchievements> => structuredClone(awards), portrait: Blob | null = null;
  let share: (data: ShareData) => Promise<void> = async () => {}; const shared: ShareData[] = [], exports: string[] = [], downloads: string[] = [];
  Object.assign(dom.window.navigator, { canShare: () => true, share(data: ShareData) { shared.push(data); return share(data); } });
  Object.assign(dom.window.URL, { createObjectURL: () => 'blob:test', revokeObjectURL() {} });
  dom.window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.download); };
  const client = { async session() { if (sessionFailure) throw sessionFailure; return session; }, async catalogue() { return { ruleVersion: 1 as const, achievements: ACHIEVEMENT_DEFINITIONS.map(({ id, name, rarity, rule }) => ({ id, name, rarity, rule })) }; }, async achievements() { return getAwards(); }, async performance() { reads++; return readPerformance(); }, async portrait() { return portrait; } };
  const el = <T extends HTMLElement>(id: string) => d.getElementById(id) as T;
  const card = mountClubCard({ dialog: el('club-card-dialog'), client, getSnapshot: () => snapshot, prepare: async svg => { exports.push(svg); return prepare(svg); }, now: () => clock });
  return { dom, card, el, exports, shared, downloads, open: () => card.open(el('opener')), click: (id: string) => el<HTMLButtonElement>(id).click(),
    get snapshot() { return snapshot!; }, setSnapshot(value: ClubCardSnapshot | null) { snapshot = value; }, setPrepare(value: typeof prepare) { prepare = value; }, setAwards(value: typeof getAwards) { getAwards = value; }, setRead(value: typeof readPerformance) { readPerformance = value; }, setShare(value: typeof share) { share = value; },
    switchAccount() { session = { authenticated: true, session: { sessionId: 'other', subject: 'other', email: 'other@example.test' } }; }, get reads() { return reads; },
    setPortrait(value: Blob) { portrait = value; },
    failSession(value: Error | null) { sessionFailure = value; },
    advance(ms: number) { clock += ms; }, scheduled,
    runDue() { for (const [id, timer] of [...timers]) if (timer.due <= clock) { timers.delete(id); timer.callback(); } },
    visibility(hidden: boolean) { Object.defineProperty(d, 'hidden', { value: hidden, configurable: true }); d.dispatchEvent(new dom.window.Event('visibilitychange')); },
    close() { card.dispose(); dom.window.close(); } };
}
test('prepared native sharing starts synchronously in click and carries a safe PNG file', async () => {
  const f = fixture(); try { await f.open(); assert.equal(f.reads, 1); assert.equal(f.el<HTMLButtonElement>('club-card-share').disabled, false);
    f.click('club-card-share'); assert.equal(f.shared.length, 1); assert.equal(f.shared[0].files?.[0].type, 'image/png'); assert.match(f.shared[0].files![0].name, /season-front.png$/);
    assert(!f.exports.join('').includes('private@example')); assert(!f.el('club-card-dialog').textContent!.includes('private@example'));
  } finally { f.close(); }
});
test('failed reverse export retries the frozen side and period without refetching a different record', async () => {
  const f = fixture(); try { await f.open(); let fails = true; f.setPrepare(async () => { if (fails) throw new Error('canvas failure'); return new f.dom.window.Blob(['png'], { type: 'image/png' }); });
    f.click('club-card-flip'); await settle(); assert.equal(f.el('club-card-retry').hidden, false); assert.equal(f.el('club-card-flip').getAttribute('aria-pressed'), 'true');
    fails = false; f.click('club-card-retry'); await settle(); f.click('club-card-download'); assert.match(f.downloads[0], /season-honours.png$/); assert.match(f.exports.at(-1)!, /THE HONOURS/);
  } finally { f.close(); }
});
test('close restores focus and discards late raster results', async () => {
  const f = fixture(); try { let finish!: (blob: Blob) => void; f.setPrepare(() => new Promise(resolve => { finish = resolve; })); const pending = f.open(); await settle();
    f.click('club-card-close'); finish(new f.dom.window.Blob(['png'], { type: 'image/png' })); await pending;
    assert.equal(f.el<HTMLDialogElement>('club-card-dialog').open, false); assert.equal(f.dom.window.document.activeElement?.id, 'opener'); assert.equal(f.el<HTMLButtonElement>('club-card-share').disabled, true); assert.equal(f.el('club-card-art').children.length, 0);
  } finally { f.close(); }
});
test('a changed source or identity prevents stale ready-file sharing', async () => {
  const f = fixture(); try { await f.open(); f.snapshot.performance.freshness.revision = 'new'; f.click('club-card-share'); assert.equal(f.shared.length, 0); assert.equal(f.el<HTMLDialogElement>('club-card-dialog').open, false); }
  finally { f.close(); }
});
test('initial open rechecks league access even without achievements after an account switch', async () => {
  const f = fixture(); try { f.snapshot.performance.capabilities.achievements = false; f.switchAccount(); f.setRead(async () => { throw new PlayerClientError(403, 'forbidden', 'Forbidden'); }); await f.open();
    assert.equal(f.reads, 1); assert.equal(f.exports.length, 0); assert.equal(f.el<HTMLButtonElement>('club-card-share').disabled, true); assert.equal(f.el<HTMLDialogElement>('club-card-dialog').open, false); assert.equal(f.el('club-card-title').textContent, 'Club Card');
  } finally { f.close(); }
});
test('missing selected portrait blocks both sides instead of sharing initials', async () => {
  const f = fixture(); try { f.snapshot.performance.player.hasPortrait = true; await f.open(); assert.equal(f.exports.length, 0); assert.equal(f.el<HTMLButtonElement>('club-card-download').disabled, true); assert.equal(f.el('club-card-retry').hidden, false); }
  finally { f.close(); }
});
test('an authorised portrait can finish card preparation while the parent profile image is still loading', async () => {
  const f = fixture(); try {
    f.snapshot.performance.player.hasPortrait = true;
    f.setPortrait(new f.dom.window.Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7WQAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }));
    await f.open(); assert.equal(f.snapshot.portraitDataUrl, null); assert.equal(f.el<HTMLButtonElement>('club-card-share').disabled, false); assert.match(f.exports[0], /<image href="data:image\/png;base64,/);
  } finally { f.close(); }
});
test('revision-mismatched honours never become a shareable reverse; front stays complete', async () => {
  const f = fixture(); try { f.setAwards(async () => ({ ...awards, freshness: { ...awards.freshness, revision: 'different' } })); await f.open(); assert.equal(f.exports.length, 1);
    f.click('club-card-flip'); await settle(); assert.equal(f.exports.length, 1); assert.equal(f.el<HTMLButtonElement>('club-card-share').disabled, true); assert.match(f.el('club-card-art').textContent!, /HONOURS ARE UPDATING/);
  } finally { f.close(); }
});
test('native share cancellation across hidden/visible keeps side and releases sharing lock', async () => {
  const f = fixture(); try { await f.open(); f.click('club-card-flip'); await settle(); let cancel!: (reason: unknown) => void; f.setShare(() => new Promise((_resolve, reject) => { cancel = reject; }));
    f.click('club-card-share'); f.visibility(true); assert.equal(f.el('club-card-art').children.length, 0); f.visibility(false); await settle();
    cancel(Object.assign(new Error('cancel'), { name: 'AbortError' })); await settle(); assert.equal(f.el<HTMLDialogElement>('club-card-dialog').open, true); assert.equal(f.el('club-card-flip').getAttribute('aria-pressed'), 'true'); assert.equal(f.el<HTMLButtonElement>('club-card-share').disabled, false);
  } finally { f.close(); }
});
test('transient visibility access failure retries in place; changed authorised record requires refresh', async () => {
  const f = fixture(); try { await f.open(); f.click('club-card-flip'); await settle(); f.visibility(true); f.setRead(async () => { throw new Error('network'); }); f.visibility(false); await settle();
    assert.equal(f.el('club-card-retry').hidden, false); assert.equal(f.el<HTMLButtonElement>('club-card-retry').disabled, false); assert.equal(f.el<HTMLButtonElement>('club-card-share').disabled, true);
    f.setRead(async () => structuredClone(f.snapshot.performance)); f.click('club-card-retry'); await settle(); assert.equal(f.el('club-card-flip').getAttribute('aria-pressed'), 'true'); assert.equal(f.el<HTMLButtonElement>('club-card-share').disabled, false);
    f.visibility(true); f.setRead(async () => ({ ...structuredClone(f.snapshot.performance), player: { ...f.snapshot.performance.player, displayName: 'Changed' } })); f.visibility(false); await settle(); assert.match(f.el('club-card-status').textContent!, /record has changed/); assert.equal(f.el<HTMLButtonElement>('club-card-share').disabled, true);
  } finally { f.close(); }
});
test('account revocation on return clears all card data and pending exports', async () => {
  const f = fixture(); try { await f.open(); f.visibility(true); f.switchAccount(); f.visibility(false); await settle(); assert.equal(f.el<HTMLDialogElement>('club-card-dialog').open, false); assert.equal(f.el('club-card-art').children.length, 0); }
  finally { f.close(); }
});
test('explicit session denial after rasterization clears rendered data instead of retaining a retryable card', async () => {
  const f = fixture(); try {
    f.setPrepare(async () => { f.failSession(new PlayerClientError(401, 'session_expired', 'Sign in')); return new f.dom.window.Blob(['png'], { type: 'image/png' }); });
    await f.open(); assert.equal(f.exports.length, 1); assert.equal(f.el<HTMLDialogElement>('club-card-dialog').open, false);
    assert.equal(f.el('club-card-art').children.length, 0); assert.equal(f.el('club-card-title').textContent, 'Club Card'); assert.equal(f.el<HTMLButtonElement>('club-card-share').disabled, true);
  } finally { f.close(); }
});
test('explicit session or resource denial on visibility return clears the frozen record', async () => {
  for (const boundary of ['session', 'performance'] as const) {
    const f = fixture(); try {
      await f.open(); f.visibility(true);
      if (boundary === 'session') f.failSession(new PlayerClientError(401, 'session_expired', 'Sign in'));
      else f.setRead(async () => { throw new PlayerClientError(403, 'league_access_denied', 'Forbidden'); });
      f.visibility(false); await settle(); assert.equal(f.el<HTMLDialogElement>('club-card-dialog').open, false);
      assert.equal(f.el('club-card-art').children.length, 0); assert.equal(f.el('club-card-title').textContent, 'Club Card'); assert.equal(f.el<HTMLButtonElement>('club-card-download').disabled, true);
    } finally { f.close(); }
  }
});
test('prepared authorization expires visibly and refresh revalidates the same reverse before native sharing', async () => {
  const f = fixture(true); try {
    await f.open(); f.click('club-card-flip'); await settle(); const reads = f.reads;
    f.advance(30_000); f.runDue();
    assert.equal(f.el<HTMLButtonElement>('club-card-share').disabled, true); assert.equal(f.el<HTMLButtonElement>('club-card-download').disabled, true);
    assert.equal(f.el('club-card-retry').textContent, 'Refresh card'); assert.equal(f.el<HTMLDialogElement>('club-card-dialog').open, true); assert.equal(f.el('club-card-flip').getAttribute('aria-pressed'), 'true');
    f.click('club-card-retry'); await settle(); assert.equal(f.reads, reads + 1); assert.equal(f.el('club-card-flip').getAttribute('aria-pressed'), 'true');
    f.click('club-card-share'); assert.equal(f.shared.length, 1, 'native share still starts before yielding the click'); assert.match(f.shared[0].files![0].name, /season-honours.png$/);
  } finally { f.close(); }
});
test('synchronous deadline blocks both release paths when the expiry timer is throttled', async () => {
  for (const button of ['club-card-share', 'club-card-download']) {
    const f = fixture(true); try {
      await f.open(); f.advance(30_000);
      assert.equal(f.el<HTMLButtonElement>(button).disabled, false, 'no timer has run'); f.click(button);
      assert.equal(f.shared.length, 0); assert.equal(f.downloads.length, 0); assert.equal(f.el('club-card-retry').textContent, 'Refresh card');
    } finally { f.close(); }
  }
});
test('resource revocation while continuously visible cannot release the expired image', async () => {
  const f = fixture(true); try {
    await f.open(); f.setRead(async () => { throw new PlayerClientError(403, 'player_profile_forbidden', 'Forbidden'); });
    f.advance(30_001); f.click('club-card-share'); assert.equal(f.shared.length, 0);
    f.click('club-card-retry'); await settle(); assert.equal(f.el<HTMLDialogElement>('club-card-dialog').open, false); assert.equal(f.el('club-card-art').children.length, 0); assert.equal(f.downloads.length, 0);
  } finally { f.close(); }
});
test('flipping and slow rendering do not renew resource authority; old timers cannot clear a refreshed file', async () => {
  const f = fixture(true); try {
    await f.open(); const oldExpiry = f.scheduled.at(-1)!;
    f.advance(29_000); f.click('club-card-flip'); await settle(); f.advance(1_000); f.runDue(); assert.equal(f.el<HTMLButtonElement>('club-card-share').disabled, true);
    f.click('club-card-retry'); await settle(); oldExpiry(); assert.equal(f.el<HTMLButtonElement>('club-card-share').disabled, false, 'superseded artifact expiry is fenced');
    f.setPrepare(async () => { f.advance(30_000); return new f.dom.window.Blob(['png'], { type: 'image/png' }); });
    f.click('club-card-flip'); await settle(); assert.equal(f.el<HTMLButtonElement>('club-card-share').disabled, true); assert.equal(f.el('club-card-retry').textContent, 'Refresh card');
  } finally { f.close(); }
});
test('an already-open native share cannot authorize another release after the lease expires', async () => {
  const f = fixture(true); try {
    await f.open(); let finish!: () => void; f.setShare(() => new Promise(resolve => { finish = resolve; }));
    f.click('club-card-share'); f.advance(30_000); f.runDue(); finish(); await settle();
    assert.equal(f.shared.length, 1); assert.equal(f.el<HTMLButtonElement>('club-card-share').disabled, true); assert.equal(f.el<HTMLButtonElement>('club-card-download').disabled, true); assert.equal(f.el('club-card-retry').textContent, 'Refresh card');
  } finally { f.close(); }
});
test('rasterization uses CSP-allowed data SVG and an exact 1200 by 1560 canvas', async () => {
  const dom = new JSDOM('', { pretendToBeVisual: true }); try {
    let source = '', width = 0, height = 0, drawn: unknown[] = [];
    class Image { onload: (() => void) | null = null; onerror: (() => void) | null = null; set src(value: string) { source = value; if (value) queueMicrotask(() => this.onload?.()); } }
    Object.defineProperty(dom.window, 'Image', { value: Image });
    dom.window.HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement) { width = this.width; height = this.height; return { drawImage(...args: unknown[]) { drawn = args; } } as unknown as CanvasRenderingContext2D; } as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;
    dom.window.HTMLCanvasElement.prototype.toBlob = function (callback) { callback(new dom.window.Blob(['png'], { type: 'image/png' })); };
    const blob = await rasterizeClubCard('<svg xmlns="http://www.w3.org/2000/svg"/>', dom.window.document); assert.equal(blob.type, 'image/png'); assert.match(source, /^data:image\/svg\+xml/); assert.deepEqual([width, height], [1200, 1560]); assert.deepEqual(drawn.slice(1), [0, 0, 1200, 1560]);
  } finally { dom.window.close(); }
});
