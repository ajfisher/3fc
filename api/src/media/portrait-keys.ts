import { historyHash } from '../data/player-history-model.js';

export const PORTRAIT_MAX_INPUT_BYTES = 2 * 1024 * 1024;
export const PORTRAIT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyPattern = /^portraits\/[a-f0-9]{64}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/;
export class PortraitInputError extends Error {
  constructor() { super('Invalid portrait image.'); this.name = 'PortraitInputError'; }
}
export function validatePortraitObjectKey(key: string): string {
  if (!keyPattern.test(key)) throw new PortraitInputError();
  return key;
}
export function portraitObjectKey(playerId: string, operationId: string): string {
  if (!playerId || !uuid.test(operationId)) throw new PortraitInputError();
  return validatePortraitObjectKey(`portraits/${historyHash(playerId)}/${operationId.toLowerCase()}.png`);
}
export function decodePortraitBase64(text: string): Buffer {
  if (!text || text.length > Math.ceil(PORTRAIT_MAX_INPUT_BYTES / 3) * 4 ||
      text.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
    throw new PortraitInputError();
  }
  const bytes = Buffer.from(text, 'base64');
  if (!bytes.length || bytes.length > PORTRAIT_MAX_INPUT_BYTES || bytes.toString('base64') !== text) throw new PortraitInputError();
  return bytes;
}
