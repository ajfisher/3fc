import { createHash } from 'node:crypto';
import { PortraitInputError, PORTRAIT_MAX_INPUT_BYTES, PORTRAIT_MAX_OUTPUT_BYTES } from './portrait-keys.js';
export * from './portrait-keys.js';
export type EncodedPortrait = { bytes: Buffer; sha256: string; contentType: 'image/png' };

/** The browser crops the source photo first; this boundary independently validates that cropped bitmap. */
export async function encodePlayerPortrait(input: Buffer): Promise<EncodedPortrait> {
  if (!input.length || input.length > PORTRAIT_MAX_INPUT_BYTES) throw new PortraitInputError();
  const png = input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = input[0] === 255 && input[1] === 216 && input[2] === 255;
  const webp = input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP';
  if (!png && !jpeg && !webp) throw new PortraitInputError();
  // Kept out of the cleanup worker dependency graph; no native addon is loaded during route import.
  const { default: sharp } = await import('sharp');
  try {
    const image = sharp(input, { failOn: 'warning', limitInputPixels: 512 * 512, animated: false });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width !== metadata.height || metadata.width > 512 ||
        (metadata.pages ?? 1) !== 1 || !['jpeg', 'png', 'webp'].includes(metadata.format ?? '')) throw new PortraitInputError();
    // Sharp drops metadata unless explicitly asked to retain it. Apply EXIF orientation before stripping it.
    const bytes = await image.autoOrient().resize(512, 512).toColourspace('srgb').png().timeout({ seconds: 3 }).toBuffer();
    if (bytes.length > PORTRAIT_MAX_OUTPUT_BYTES) throw new PortraitInputError();
    return { bytes, sha256: createHash('sha256').update(bytes).digest('hex'), contentType: 'image/png' };
  } catch { throw new PortraitInputError(); }
}
