import assert from 'node:assert/strict';
import test from 'node:test';
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { initializeRestoringPlayerSettings } from '../ui/player-settings.js';
import { PlayerClientError, type OwnerDetails } from '../ui/player-client.js';
import type { PortraitSource } from '../ui/portrait-crop.js';
const markup = `<div id="account-actions" hidden><button id="sign-out">Sign out</button><p id="sign-out-status"></p></div><main id="player-settings"><a id="owner-signin" hidden>Sign in</a><p id="owner-status" role="status"></p><button id="owner-retry">Retry</button><button id="owner-refresh">Refresh</button>
<section id="owner-form" hidden><form id="owner-name-form"><input id="owner-name"><input id="owner-email" readonly><button id="owner-save-name">Save name</button></form>
<img id="owner-photo-preview" hidden><input id="owner-photo-file" type="file"><button id="owner-photo-remove">Remove</button><button id="owner-photo-save">Save photo</button>
<p id="owner-photo-notice">Your portrait appears to authorised league viewers and in shared card images.</p></section>
<dialog id="portrait-crop-dialog"><canvas id="portrait-crop-canvas"></canvas><input id="portrait-crop-zoom" type="range" min="1" max="4" step=".01"><input id="portrait-crop-x" type="range" min="-1" max="1"><input id="portrait-crop-y" type="range" min="-1" max="1"><p id="portrait-crop-status"></p><button id="portrait-crop-confirm">Use crop</button><button id="portrait-crop-cancel">Cancel</button></dialog></main>`;
const original: OwnerDetails = { playerId: 'canonical', displayName: 'Xavier', hasPortrait: false, revision: 'a'.repeat(64) };
async function settle() { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); }
function setup(options: { hasPortrait?: boolean; context?: boolean } = {}) {
  const dom = new JSDOM(markup, { url: 'https://qa.3fc.football/player-settings?playerId=alias', pretendToBeVisual: true });
  const d = dom.window.document;
  Object.defineProperty(dom.window, 'crypto', { value: webcrypto });
  Object.assign(dom.window.HTMLDialogElement.prototype, { showModal(this: HTMLDialogElement) { this.open = true; }, close(this: HTMLDialogElement) { this.open = false; } });
  let owner = { ...original, hasPortrait: Boolean(options.hasPortrait) }, session = { authenticated: true, session: { sessionId: 'session', subject: 'account', email: 'private@example.test' } };
  const calls: Array<{ kind: string; playerId: string; body: any }> = [];
  let behavior: (kind: string, body: any) => Promise<void> = async () => {};
  let ownerFailure = false, sessionFailure = false, receipt: OwnerDetails | null = null;
  const mutate = async (kind: string, playerId: string, body: any) => {
    calls.push({ kind, playerId, body: { ...body } }); await behavior(kind, body);
    if (receipt) return { ...receipt };
    owner = { ...owner, revision: 'b'.repeat(64), ...(kind === 'name' ? { displayName: body.displayName } : { hasPortrait: kind === 'photo' }) }; return { ...owner };
  };
  let disposedSource = 0;
  let decode: () => Promise<PortraitSource> = async () => ({ image: {} as CanvasImageSource, width: 800, height: 600, dispose() { disposedSource++; } });
  const client = { async logout() {}, async session() { if (sessionFailure) throw new Error('session unavailable'); return session; }, async owner() { if (ownerFailure) throw new Error('owner unavailable'); return { ...owner, email: 'private@example.test' }; },
    rename: (playerId: string, body: any) => mutate('name', playerId, body), uploadPortrait: (playerId: string, body: any) => mutate('photo', playerId, body), removePortrait: (playerId: string, body: any) => mutate('remove', playerId, body),
    async portrait() { return new Blob(['portrait'], { type: 'image/png' }); } };
  const ui = initializeRestoringPlayerSettings({ root: d.getElementById('player-settings')!, client, playerId: 'alias',
    ...(options.context ? { context: { leagueId: 'league', playerId: 'alias' } } : {}),
    media: { decode: () => decode(), draw() {}, async encode() { return { base64: 'cG5n', previewDataUrl: 'data:image/png;base64,cG5n', contentType: 'image/png' }; }, async dataUrl() { return 'data:image/png;base64,c2F2ZWQ='; } } });
  const el = <T extends HTMLElement>(id: string) => d.getElementById(id) as T;
  const click = (id: string) => el<HTMLButtonElement>(id).click();
  const submit = (value: string) => { el<HTMLInputElement>('owner-name').value = value; el('owner-name-form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })); };
  const choose = async () => { const file = el<HTMLInputElement>('owner-photo-file'); Object.defineProperty(file, 'files', { value: [new dom.window.File(['data'], 'photo.png', { type: 'image/png' })], configurable: true }); file.focus(); file.dispatchEvent(new dom.window.Event('change')); await settle(); };
  return { dom, ui, el, click, submit, choose, calls, get ready() { return ui.ready; }, get owner() { return owner; }, get disposedSource() { return disposedSource; },
    behavior(fn: typeof behavior) { behavior = fn; }, failOwner(value: boolean) { ownerFailure = value; }, failSession(value: boolean) { sessionFailure = value; }, staleReceipt(value: OwnerDetails) { receipt = value; }, decode(fn: typeof decode) { decode = fn; }, changeOwner(value: Partial<OwnerDetails>) { owner = { ...owner, ...value }; },
    switchAccount() { session = { authenticated: true, session: { sessionId: 'new-session', subject: 'another-account', email: 'other@example.test' } }; },
    close() { ui.dispose(); dom.window.close(); } };
}
test('owner-only details render without a league and no account email enters a save payload', async () => {
  const f = setup(); try { await f.ready;
    assert.equal(f.el<HTMLInputElement>('owner-email').value, 'private@example.test'); assert.equal(f.el<HTMLInputElement>('owner-email').readOnly, true);
    assert.equal(f.el('owner-form').hidden, false); assert.equal(f.el('owner-photo-preview').hidden, true);
    f.submit('Xavier David'); await settle();
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].playerId, 'canonical'); assert.equal(f.calls[0].body.expectedRevision, original.revision);
    assert.equal(f.calls[0].body.displayName, 'Xavier David'); assert(!JSON.stringify(f.calls).includes('private@example'));
    assert.match(f.el('owner-status').textContent!, /Save confirmed/);
  } finally { f.close(); }
});
test('ambiguous saves freeze all writes and retry the identical key, revision and payload', async () => {
  const f = setup(); try { await f.ready;
    let failures = 1; f.behavior(async () => { if (failures--) throw new Error('lost acknowledgment'); });
    f.submit('Xavi'); await settle(); const first = structuredClone(f.calls[0]);
    assert.equal(f.el<HTMLInputElement>('owner-name').disabled, true); assert.equal(f.el<HTMLInputElement>('owner-photo-file').disabled, true);
    f.submit('different'); assert.equal(f.calls.length, 1);
    f.click('owner-retry'); await settle(); assert.deepEqual(f.calls[1], first); assert.equal(f.el<HTMLInputElement>('owner-name').value, 'Xavi');
  } finally { f.close(); }
});
test('revision conflict retains drafts and requires refresh before a new save key', async () => {
  const f = setup(); try { await f.ready;
    f.behavior(async () => { throw new PlayerClientError(409, 'owner_profile_changed', 'Changed'); });
    f.submit('Draft name'); await settle(); const first = f.calls[0];
    assert.equal(f.el<HTMLInputElement>('owner-name').value, 'Draft name'); assert.equal(f.el('owner-refresh').hidden, false);
    f.submit('Draft name'); assert.equal(f.calls.length, 1);
    f.changeOwner({ revision: 'c'.repeat(64), displayName: 'Server name' }); f.behavior(async () => {});
    f.click('owner-refresh'); await settle(); assert.equal(f.el<HTMLInputElement>('owner-name').value, 'Draft name');
    f.submit('Draft name'); await settle(); assert.equal(f.calls[1].body.expectedRevision, 'c'.repeat(64)); assert.notEqual(f.calls[1].body.idempotencyKey, first.body.idempotencyKey);
  } finally { f.close(); }
});
test('account changes clear private data and cannot retry the preceding account request', async () => {
  const f = setup(); try { await f.ready;
    f.behavior(async () => { throw new Error('network'); }); f.submit('Draft'); await settle();
    f.switchAccount(); f.click('owner-retry'); await settle();
    assert.equal(f.calls.length, 1); assert.equal(f.el<HTMLInputElement>('owner-email').value, ''); assert.equal(f.el<HTMLInputElement>('owner-name').value, ''); assert.equal(f.el('owner-form').hidden, true);
  } finally { f.close(); }
});
test('crop can be cancelled with focus return, then confirmed and saved without losing a name draft', async () => {
  const f = setup({ hasPortrait: true, context: true }); try { await f.ready;
    assert.equal(f.el<HTMLImageElement>('owner-photo-preview').src, 'data:image/png;base64,c2F2ZWQ=');
    await f.choose(); assert.equal(f.el<HTMLDialogElement>('portrait-crop-dialog').open, true);
    f.el('portrait-crop-dialog').dispatchEvent(new f.dom.window.Event('cancel', { cancelable: true }));
    assert.equal(f.dom.window.document.activeElement, f.el('owner-photo-file')); assert.equal(f.disposedSource, 1); assert.equal(f.calls.length, 0);
    f.el<HTMLInputElement>('owner-name').value = 'Unsaved name';
    await f.choose(); f.click('portrait-crop-confirm'); await settle();
    assert.equal(f.el<HTMLDialogElement>('portrait-crop-dialog').open, false); assert.equal(f.calls.length, 0);
    assert.match(f.el('owner-photo-notice').textContent!, /shared card/);
    f.click('owner-photo-save'); await settle(); assert.equal(f.calls[0].kind, 'photo'); assert.equal(f.calls[0].body.base64, 'cG5n');
    assert.equal(f.el<HTMLInputElement>('owner-name').value, 'Unsaved name');
    f.click('owner-photo-remove'); await settle(); assert.equal(f.calls[1].body.expectedRevision, 'b'.repeat(64)); assert.equal(f.el('owner-photo-preview').hidden, true);
  } finally { f.close(); }
});
test('pending crop decode and network results cannot repopulate a disposed private screen', async () => {
  const f = setup(); try { await f.ready;
    let resolve!: (value: PortraitSource) => void;
    f.decode(() => new Promise(value => { resolve = value; }));
    await f.choose(); assert.equal(f.el<HTMLButtonElement>('owner-save-name').disabled, true);
    f.ui.dispose(); let closed = false; resolve({ image: {} as CanvasImageSource, width: 100, height: 100, dispose() { closed = true; } }); await settle();
    assert.equal(closed, true); assert.equal(f.el<HTMLInputElement>('owner-email').value, ''); assert.equal(f.el<HTMLDialogElement>('portrait-crop-dialog').open, false);
  } finally { f.close(); }
});
test('a replayed save receipt never overwrites newer owner details or invents a current portrait', async () => {
  const f = setup({ context: true }); try { await f.ready;
    f.changeOwner({ displayName: 'Newer server name', revision: 'c'.repeat(64), hasPortrait: false });
    f.staleReceipt({ ...original, displayName: 'Older receipt', revision: 'b'.repeat(64), hasPortrait: true });
    f.submit('Older receipt'); await settle();
    assert.equal(f.el<HTMLInputElement>('owner-name').value, 'Newer server name'); assert.equal(f.el('owner-photo-preview').hidden, true);
    f.submit('Next change'); await settle(); assert.equal(f.calls[1].body.expectedRevision, 'c'.repeat(64));
  } finally { f.close(); }
});
test('confirmed save with failed reread offers refresh without sending the mutation again', async () => {
  const f = setup(); try { await f.ready;
    f.behavior(async () => { f.failOwner(true); }); f.submit('Saved name'); await settle();
    assert.equal(f.el('owner-refresh').hidden, false); assert.equal(f.el('owner-form').hidden, true);
    assert.match(f.el('owner-status').textContent!, /Save confirmed/);
    f.failOwner(false); f.click('owner-refresh'); await settle(); assert.equal(f.calls.length, 1);
    assert.equal(f.el('owner-form').hidden, false);
  } finally { f.close(); }
});
test('focus account checks fail closed, and sign out clears private content immediately', async () => {
  const f = setup(); try { await f.ready;
    assert.equal(f.el('account-actions').hidden, false);
    f.failSession(true); f.dom.window.dispatchEvent(new f.dom.window.Event('focus')); await settle();
    assert.equal(f.el('owner-form').hidden, true); assert.equal(f.el<HTMLInputElement>('owner-name').disabled, true);
    assert.equal(f.el('owner-retry').hidden, false);
    f.failSession(false); f.click('owner-retry'); await settle(); assert.equal(f.el('owner-form').hidden, false);
    f.click('sign-out'); assert.equal(f.el<HTMLInputElement>('owner-email').value, ''); await settle();
    assert.equal(f.el('owner-form').hidden, true); assert.equal(f.el('owner-signin').hidden, false);
  } finally { f.close(); }
});
test('BFCache restoration remounts from current owner state after wiping the private snapshot', async () => {
  const f = setup(); try { await f.ready;
    f.dom.window.dispatchEvent(new f.dom.window.PageTransitionEvent('pagehide', { persisted: true }));
    assert.equal(f.el<HTMLInputElement>('owner-email').value, '');
    f.changeOwner({ displayName: 'Changed while away', revision: 'c'.repeat(64) });
    f.dom.window.dispatchEvent(new f.dom.window.PageTransitionEvent('pageshow', { persisted: true }));
    await f.ui.ready;
    assert.equal(f.el<HTMLInputElement>('owner-name').value, 'Changed while away');
    assert.equal(f.el<HTMLInputElement>('owner-email').value, 'private@example.test');
    f.submit('A fresh save'); await settle(); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.expectedRevision, 'c'.repeat(64));
  } finally { f.close(); }
});

for (const event of ['threefc:player-proof-cleared', 'threefc:player-proof-invalidated']) test(`${event} clears email, portrait and ambiguous write ownership`, async () => {
  const f = setup({ hasPortrait: true, context: true }); try { await f.ready;
    f.behavior(async () => { throw new Error('ambiguous write'); }); f.submit('Private draft'); await settle();
    f.dom.window.dispatchEvent(new f.dom.window.Event(event));
    assert.equal(f.el<HTMLInputElement>('owner-email').value, ''); assert.equal(f.el<HTMLInputElement>('owner-name').value, '');
    assert.equal(f.el<HTMLImageElement>('owner-photo-preview').hasAttribute('src'), false);
    f.click('owner-retry'); await settle(); assert.equal(f.calls.length, 1); assert.equal(f.el('owner-form').hidden, true);
  } finally { f.close(); }
});
