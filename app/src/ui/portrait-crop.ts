export const PORTRAIT_SOURCE_MAX_BYTES = 8 * 1024 * 1024;
export const PORTRAIT_SOURCE_MAX_PIXELS = 16_000_000;
export type PortraitFormat = 'image/jpeg' | 'image/png' | 'image/webp';
export type PortraitDimensions = { width: number; height: number; format: PortraitFormat };
export type CropPosition = { zoom: number; panX: number; panY: number };
export type PortraitSource = { image: CanvasImageSource; width: number; height: number; dispose(): void };
export class PortraitCropError extends Error {
  constructor(message = 'Choose a valid JPEG, PNG or WebP photo.') { super(message); this.name = 'PortraitCropError'; }
}
const invalid = (): never => { throw new PortraitCropError(); };
function dimensions(width: number, height: number, format: PortraitFormat): PortraitDimensions {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) invalid();
  if (width * height > PORTRAIT_SOURCE_MAX_PIXELS) throw new PortraitCropError('Choose a photo with no more than 16 megapixels.');
  return { width, height, format };
}
/** Read bounded raster headers before allocating a decoded bitmap. */
export function inspectPortraitBytes(bytes: Uint8Array): PortraitDimensions {
  if (!bytes.length || bytes.length > PORTRAIT_SOURCE_MAX_BYTES) throw new PortraitCropError('Choose a photo smaller than 8 MB.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (at: number, size: number) => String.fromCharCode(...bytes.subarray(at, at + size));
  const u24 = (at: number) => bytes[at] + bytes[at + 1] * 256 + bytes[at + 2] * 65536;
  if (bytes.length >= 33 && bytes[0] === 137 && ascii(1, 7) === 'PNG\r\n\x1a\n') {
    if (view.getUint32(8) !== 13 || ascii(12, 4) !== 'IHDR') invalid();
    return dimensions(view.getUint32(16), view.getUint32(20), 'image/png');
  }
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') {
    const end = view.getUint32(4, true) + 8;
    if (end !== bytes.length) invalid();
    for (let at = 12; at + 8 <= end;) {
      const kind = ascii(at, 4), length = view.getUint32(at + 4, true), start = at + 8;
      if (start + length > end) invalid();
      if (kind === 'VP8X') {
        if (length !== 10) invalid();
        return dimensions(u24(start + 4) + 1, u24(start + 7) + 1, 'image/webp');
      }
      if (kind === 'VP8 ') {
        if (length < 10 || ascii(start + 3, 3) !== '\x9d\x01\x2a') invalid();
        return dimensions(view.getUint16(start + 6, true) & 16383, view.getUint16(start + 8, true) & 16383, 'image/webp');
      }
      if (kind === 'VP8L') {
        if (length < 5 || bytes[start] !== 47) invalid();
        const bits = view.getUint32(start + 1, true);
        return dimensions((bits & 16383) + 1, ((bits >>> 14) & 16383) + 1, 'image/webp');
      }
      at = start + length + length % 2;
    }
    invalid();
  }
  if (bytes[0] === 255 && bytes[1] === 216) {
    for (let at = 2; at < bytes.length;) {
      if (bytes[at++] !== 255) invalid();
      while (bytes[at] === 255) at += 1;
      const marker = bytes[at++];
      if (marker === undefined || marker === 217 || marker === 218 || marker === 0) invalid();
      if (marker === 1 || marker >= 208 && marker <= 215) continue;
      if (at + 2 > bytes.length) invalid();
      const length = view.getUint16(at);
      if (length < 2 || at + length > bytes.length) invalid();
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker)) {
        if (length < 8) invalid();
        return dimensions(view.getUint16(at + 5), view.getUint16(at + 3), 'image/jpeg');
      }
      at += length;
    }
  }
  return invalid();
}
export async function inspectPortraitSource(file: Blob): Promise<PortraitDimensions> {
  if (!file.size || file.size > PORTRAIT_SOURCE_MAX_BYTES) throw new PortraitCropError('Choose a photo smaller than 8 MB.');
  const result = inspectPortraitBytes(new Uint8Array(await file.arrayBuffer()));
  if (file.type && file.type !== result.format) invalid();
  return result;
}
export function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new PortraitCropError());
    reader.onerror = () => reject(new PortraitCropError('The photo could not be read. Choose it again.'));
    reader.readAsDataURL(blob);
  });
}
export async function decodePortraitSource(file: Blob): Promise<PortraitSource> {
  await inspectPortraitSource(file);
  if (typeof createImageBitmap === 'function') {
    const image = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try { dimensions(image.width, image.height, 'image/png'); }
    catch (error) { image.close(); throw error; }
    return { image, width: image.width, height: image.height, dispose: () => image.close() };
  }
  // data: is permitted by the existing CSP; blob: is deliberately unnecessary.
  const image = new Image();
  const loaded = new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new PortraitCropError()); });
  image.src = await blobDataUrl(file); await loaded;
  try { dimensions(image.naturalWidth, image.naturalHeight, 'image/png'); }
  catch (error) { image.removeAttribute('src'); throw error; }
  return { image, width: image.naturalWidth, height: image.naturalHeight, dispose: () => image.removeAttribute('src') };
}
export function portraitCropRectangle(width: number, height: number, position: CropPosition) {
  dimensions(width, height, 'image/png');
  if (![position.zoom, position.panX, position.panY].every(Number.isFinite)) invalid();
  const size = Math.min(width, height) / Math.max(1, Math.min(4, position.zoom));
  const x = (width - size) * (Math.max(-1, Math.min(1, position.panX)) + 1) / 2;
  const y = (height - size) * (Math.max(-1, Math.min(1, position.panY)) + 1) / 2;
  return { x, y, size };
}
export function drawPortraitCrop(canvas: HTMLCanvasElement, source: PortraitSource, position: CropPosition): void {
  const context = canvas.getContext('2d'); if (!context) throw new PortraitCropError('Photo cropping is unavailable in this browser.');
  const { x, y, size } = portraitCropRectangle(source.width, source.height, position);
  canvas.width = 512; canvas.height = 512;
  context.clearRect(0, 0, 512, 512); context.drawImage(source.image, x, y, size, size, 0, 0, 512, 512);
}
export async function encodePortraitCrop(canvas: HTMLCanvasElement): Promise<{ base64: string; previewDataUrl: string; contentType: 'image/png' }> {
  const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new PortraitCropError('The crop could not be prepared. Try again.')), 'image/png'));
  if (blob.size > 2 * 1024 * 1024 || blob.type !== 'image/png') throw new PortraitCropError('The crop is too large. Try again.');
  const previewDataUrl = await blobDataUrl(blob);
  if (!previewDataUrl.startsWith('data:image/png;base64,')) invalid();
  return { base64: previewDataUrl.slice('data:image/png;base64,'.length), previewDataUrl, contentType: 'image/png' };
}
