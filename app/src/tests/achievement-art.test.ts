import assert from 'node:assert/strict';
import test from 'node:test';
import { ACHIEVEMENT_DEFINITIONS } from '@3fc/contracts';
import { JSDOM } from 'jsdom';
import { renderBadge } from '../ui/achievement-art.js';

test('every approved class renders self-contained vector artwork without executable or external content', () => {
  for (const badge of ACHIEVEMENT_DEFINITIONS) {
    const dom = new JSDOM(renderBadge(badge.id), { contentType: 'image/svg+xml' });
    try {
      const svg = dom.window.document.documentElement;
      assert.equal(svg.getAttribute('viewBox'), '0 0 160 184');
      assert.match(svg.querySelector('title')!.textContent!, new RegExp(badge.name));
      assert.equal(svg.querySelectorAll('script,foreignObject,image,style,a').length, 0);
      for (const element of [svg, ...svg.querySelectorAll('*')]) {
        assert.equal([...element.attributes].some(attribute => attribute.name !== "xmlns" && (/^on/i.test(attribute.name) || /(?:https?:|javascript:|url\()/i.test(attribute.value))), false);
      }
      assert(svg.querySelectorAll('path').length > 0);
    } finally { dom.window.close(); }
  }
});
test('five individual milestone stars become a readable compact count at six', () => {
  const starCount = (ordinal: number) => (renderBadge('played', ordinal).match(/M0-5L1\.5/g) ?? []).length;
  assert.equal(starCount(0), 0); assert.equal(starCount(1), 1); assert.equal(starCount(5), 5);
  assert.equal(starCount(6), 1); assert.match(renderBadge('played', Number.MAX_SAFE_INTEGER), /textLength="68"/); assert.match(renderBadge('played', 123), />123<\/text>/);
  for (const ordinal of [-1, 1.1, NaN, Infinity]) assert.throws(() => renderBadge('played', ordinal));
});
