import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, lstat, open, link, unlink } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PORTRAIT_MAX_OUTPUT_BYTES, validatePortraitObjectKey } from './portrait-keys.js';

export interface PortraitStore {
  put(key: string, bytes: Buffer, signal?: AbortSignal): Promise<void>;
  get(key: string, signal?: AbortSignal): Promise<Buffer | null>;
  delete(key: string, signal?: AbortSignal): Promise<void>;
}
export class PortraitStorageError extends Error {
  constructor() { super('Portrait storage unavailable.'); this.name = 'PortraitStorageError'; }
}
function deadline(signal?: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(5000), ...(signal ? [signal] : [])]);
}
function storedImage(bytes: Buffer): void {
  if (bytes.length < 24 || bytes.length > PORTRAIT_MAX_OUTPUT_BYTES ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(16) !== 512 || bytes.readUInt32BE(20) !== 512) throw new PortraitStorageError();
}
function sameBytes(a: Buffer, b: Buffer | null): void {
  if (!b || a.length !== b.length || createHash('sha256').update(a).digest('hex') !== createHash('sha256').update(b).digest('hex')) throw new PortraitStorageError();
}
function missing(error: unknown): boolean {
  return error instanceof Error && (error.name === 'NoSuchKey' || (error as { code?: string }).code === 'ENOENT');
}
export function createS3PortraitStore(bucket: string, client = new S3Client({ maxAttempts: 1, requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 } })): PortraitStore {
  const get = async (key: string, signal?: AbortSignal): Promise<Buffer | null> => {
    validatePortraitObjectKey(key);
    const bounded = deadline(signal);
    bounded.throwIfAborted();
    try {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: bounded });
      if (!(result.Body instanceof Readable)) throw new PortraitStorageError();
      const body = result.Body;
      const abort = () => { body.destroy(new PortraitStorageError()); };
      bounded.addEventListener('abort', abort, { once: true });
      try {
        bounded.throwIfAborted();
        if (result.ContentType !== 'image/png' || (result.ContentLength ?? 0) > PORTRAIT_MAX_OUTPUT_BYTES) throw new PortraitStorageError();
        const parts: Buffer[] = []; let size = 0;
        for await (const chunk of body) {
          bounded.throwIfAborted();
          const bytes = Buffer.from(chunk as Uint8Array); size += bytes.length;
          if (size > PORTRAIT_MAX_OUTPUT_BYTES) throw new PortraitStorageError();
          parts.push(bytes);
        }
        const bytes = Buffer.concat(parts); storedImage(bytes); return bytes;
      } finally { bounded.removeEventListener('abort', abort); body.destroy(); }
    } catch (error) { if (missing(error)) return null; throw error; }
  };
  return {
    get,
    async put(key, bytes, signal) {
      validatePortraitObjectKey(key); storedImage(bytes);
      const bounded = deadline(signal); bounded.throwIfAborted();
      try {
        await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: bytes, ContentType: 'image/png', CacheControl: 'no-store', IfNoneMatch: '*', ServerSideEncryption: 'AES256' }), { abortSignal: bounded });
      } catch (error) {
        if (!(error instanceof Error) || (error.name !== 'PreconditionFailed' && error.name !== 'ConditionalRequestConflict')) throw error;
        sameBytes(bytes, await get(key, bounded));
      }
    },
    async delete(key, signal) {
      validatePortraitObjectKey(key); const bounded = deadline(signal); bounded.throwIfAborted();
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: bounded });
    }
  };
}

/** Explicit private local directory: never placed under the application's static root. */
export function createLocalPortraitStore(directory: string): PortraitStore {
  const root = resolve(directory);
  const pathFor = async (key: string, signal: AbortSignal): Promise<string> => {
    validatePortraitObjectKey(key); signal.throwIfAborted();
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await lstat(root)).isSymbolicLink()) throw new PortraitStorageError();
    const file = resolve(root, key);
    if (!file.startsWith(root + sep)) throw new PortraitStorageError();
    // No directory is supplied by a caller: both components are fixed or validated hex.
    for (const part of [resolve(root, 'portraits'), dirname(file)]) {
      await mkdir(part, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
      const stat = await lstat(part);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new PortraitStorageError();
    }
    signal.throwIfAborted(); return file;
  };
  const get = async (key: string, signal?: AbortSignal): Promise<Buffer | null> => {
    const bounded = deadline(signal); const file = await pathFor(key, bounded);
    try {
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > PORTRAIT_MAX_OUTPUT_BYTES) throw new PortraitStorageError();
        const bytes = await handle.readFile({ signal: bounded }); storedImage(bytes); return bytes;
      } finally { await handle.close(); }
    } catch (error) { if (missing(error)) return null; throw error; }
  };
  return {
    get,
    async put(key, bytes, signal) {
      storedImage(bytes); const bounded = deadline(signal); const file = await pathFor(key, bounded);
      const temporary = `${file}.${randomUUID()}.tmp`;
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(bytes, { signal: bounded }); await handle.sync(); await handle.close(); bounded.throwIfAborted();
        try { await link(temporary, file); } catch (error) {
          if ((error as { code?: string }).code !== 'EEXIST') throw error;
          sameBytes(bytes, await get(key, bounded));
        }
      } finally { await handle.close(); await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    },
    async delete(key, signal) {
      const bounded = deadline(signal); const file = await pathFor(key, bounded);
      try { await unlink(file); } catch (error) { if (!missing(error)) throw error; }
    }
  };
}
export function createPortraitStore(): PortraitStore {
  const bucket = process.env.PORTRAIT_BUCKET;
  const directory = process.env.PORTRAIT_LOCAL_DIRECTORY;
  if (bucket && !directory) return createS3PortraitStore(bucket);
  if (directory && !bucket) return createLocalPortraitStore(directory);
  throw new PortraitStorageError();
}
