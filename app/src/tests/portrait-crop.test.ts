import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectPortraitBytes, inspectPortraitSource, portraitCropRectangle, drawPortraitCrop, PORTRAIT_SOURCE_MAX_BYTES } from '../ui/portrait-crop.js';
function png(width: number, height: number) {
  const bytes = new Uint8Array(33), view = new DataView(bytes.buffer);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); view.setUint32(8, 13); bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width); view.setUint32(20, height); return bytes;
}
function webp(kind: 'VP8X' | 'VP8 ' | 'VP8L', width: number, height: number) {
  const length = kind === 'VP8L' ? 6 : 10, bytes = new Uint8Array(20 + length), view = new DataView(bytes.buffer);
  for (const [at, text] of [[0, 'RIFF'], [8, 'WEBP'], [12, kind]] as const) bytes.set([...text].map(c => c.charCodeAt(0)), at);
  view.setUint32(4, bytes.length - 8, true); view.setUint32(16, length, true);
  if (kind === 'VP8X') { for (const [at, value] of [[24, width - 1], [27, height - 1]]) { bytes[at] = value & 255; bytes[at + 1] = value >>> 8 & 255; bytes[at + 2] = value >>> 16 & 255; } }
  else if (kind === 'VP8 ') { bytes.set([157, 1, 42], 23); view.setUint16(26, width, true); view.setUint16(28, height, true); }
  else { bytes[20] = 47; view.setUint32(21, (width - 1) | ((height - 1) << 14), true); }
  return bytes;
}
function jpeg(width: number, height: number) {
  // APP metadata preceding SOF2 exercises segment traversal, not fixed offsets.
  const bytes = new Uint8Array([255, 216, 255, 225, 0, 4, 1, 2, 255, 194, 0, 8, 8, 0, 0, 0, 0, 1]);
  const view = new DataView(bytes.buffer); view.setUint16(13, height); view.setUint16(15, width); return bytes;
}
test('preflight reads all supported raster dimension encodings before decoding', () => {
  for (const [bytes, format] of [[png(1200, 1600), 'image/png'], [jpeg(1200, 1600), 'image/jpeg'], ...(['VP8X', 'VP8 ', 'VP8L'] as const).map(kind => [webp(kind, 1200, 1600), 'image/webp'])] as Array<[Uint8Array, string]>)
    assert.deepEqual(inspectPortraitBytes(bytes), { width: 1200, height: 1600, format });
  assert.equal(inspectPortraitBytes(png(4000, 4000)).width, 4000);
  for (const bytes of [png(4001, 4000), jpeg(5000, 5000), webp('VP8X', 16000, 16000), png(0, 100), new Uint8Array(10), new TextEncoder().encode('<svg/>'), jpeg(10, 10).subarray(0, 15), webp('VP8L', 10, 10).subarray(0, 20)]) assert.throws(() => inspectPortraitBytes(bytes));
});
test('byte and type limits are enforced before loading or allocating an image', async () => {
  let reads = 0;
  const oversized = { size: PORTRAIT_SOURCE_MAX_BYTES + 1, type: 'image/png', async arrayBuffer() { reads += 1; return png(1, 1).buffer; } } as Blob;
  await assert.rejects(inspectPortraitSource(oversized)); assert.equal(reads, 0);
  await assert.rejects(inspectPortraitSource(new Blob([png(10, 10)], { type: 'image/svg+xml' })));
  assert.deepEqual(await inspectPortraitSource(new Blob([jpeg(10, 20)])), { width: 10, height: 20, format: 'image/jpeg' });
  const malformed = png(10, 10); malformed[12] = 0; assert.throws(() => inspectPortraitBytes(malformed));
});
test('square crops stay inside either orientation at every keyboard slider extreme', () => {
  assert.deepEqual(portraitCropRectangle(1600, 1200, { zoom: 1, panX: 0, panY: 0 }), { x: 200, y: 0, size: 1200 });
  for (const [width, height] of [[1600, 1200], [1200, 1600], [512, 512]]) for (const zoom of [1, 1.25, 4]) for (const panX of [-1, 0, 1]) for (const panY of [-1, 0, 1]) {
    const crop = portraitCropRectangle(width, height, { zoom, panX, panY });
    assert(crop.x >= 0 && crop.y >= 0 && crop.x + crop.size <= width && crop.y + crop.size <= height);
    assert.equal(crop.size, Math.min(width, height) / zoom);
  }
  assert.throws(() => portraitCropRectangle(10, 10, { zoom: NaN, panX: 0, panY: 0 }));
  const calls: unknown[][] = [], image = {} as CanvasImageSource;
  const canvas = { width: 10, height: 10, getContext: () => ({ clearRect() {}, drawImage: (...args: unknown[]) => calls.push(args) }) } as unknown as HTMLCanvasElement;
  drawPortraitCrop(canvas, { image, width: 1600, height: 1200, dispose() {} }, { zoom: 2, panX: 1, panY: -1 });
  assert.equal(canvas.width, 512); assert.equal(canvas.height, 512);
  assert.deepEqual(calls, [[image, 1000, 0, 600, 600, 0, 0, 512, 512]]);
});
