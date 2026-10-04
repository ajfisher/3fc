import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { renderPlayerProfilePage, renderPlayerSettingsPage } from '../ui/layout.js';

test('player shells render no fixture data and keep account fields on the owner screen', () => {
  const profile = new JSDOM(renderPlayerProfilePage('https://api.example.invalid'));
  const settings = new JSDOM(renderPlayerSettingsPage('https://api.example.invalid'));
  try {
    const p = profile.window.document, s = settings.window.document;
    assert.equal(p.querySelector('#player-content')?.hasAttribute('hidden'), true);
    assert.equal(p.querySelector('#player-name')?.textContent, '');
    assert.equal(p.querySelector('input[type=email]'), null);
    assert.equal(p.querySelector('#player-edit')?.hasAttribute('hidden'), true);
    assert.equal(p.querySelector<HTMLInputElement>('input[name=player-period]:checked')?.value, 'season');
    assert.equal(p.querySelector('#player-history-more')?.hasAttribute('hidden'), true);
    assert.equal(s.querySelector('#owner-form')?.hasAttribute('hidden'), true);
    assert.equal(s.querySelector<HTMLInputElement>('#owner-email')?.readOnly, true);
    assert.equal(s.querySelector<HTMLInputElement>('#owner-email')?.value, '');
    assert.match(s.querySelector('#owner-photo-notice')?.textContent ?? '', /signed in players in your league or images you share/);
    assert.equal(s.querySelector('#portrait-crop-dialog')?.getAttribute('aria-labelledby'), 'portrait-crop-title');
    for (const id of ['zoom', 'x', 'y']) assert(s.querySelector(`label[for=portrait-crop-${id}]`));
    for (const doc of [p, s]) {
      assert.equal(doc.querySelectorAll('script:not([src])').length, 0);
      assert.equal(doc.querySelector('meta[name=referrer]')?.getAttribute('content'), 'no-referrer');
      assert.doesNotMatch(doc.body.textContent ?? '', /Xavier|XP level|star slider/);
    }
  } finally { profile.window.close(); settings.window.close(); }
});

test('new player screen scripts carry the existing asset version and escaped API URL', () => {
  const previous = process.env.THREEFC_ASSET_VERSION;
  process.env.THREEFC_ASSET_VERSION = 'reviewed-head';
  try {
    for (const [kind, render] of [['profile', renderPlayerProfilePage], ['settings', renderPlayerSettingsPage]] as const) {
      const dom = new JSDOM(render('https://api.example.invalid/?x="&y=<'));
      try {
        const doc = dom.window.document;
        assert.equal(doc.querySelector(`script[src='/ui/player-${kind}-browser.js?v=reviewed-head']`)?.hasAttribute('defer'), true);
        assert.equal(doc.body.dataset.apiBaseUrl, 'https://api.example.invalid/?x="&y=<');
        assert.equal(doc.querySelectorAll('body').length, 1);
      } finally { dom.window.close(); }
    }
  } finally {
    if (previous === undefined) delete process.env.THREEFC_ASSET_VERSION; else process.env.THREEFC_ASSET_VERSION = previous;
  }
});
