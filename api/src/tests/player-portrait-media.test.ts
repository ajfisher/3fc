import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { decodePortraitBase64, encodePlayerPortrait, portraitObjectKey, PortraitInputError, PORTRAIT_MAX_INPUT_BYTES } from '../media/player-portrait.js';
import { createLocalPortraitStore, createS3PortraitStore } from '../media/portrait-store.js';
const key = () => portraitObjectKey('canonical/player?#one', randomUUID());
const bitmap = () => sharp({ create: { width: 64, height: 64, channels: 3, background: '#cfa542' } });

test('cropped JPEG PNG and WebP become metadata-free 512 PNG with a content digest', async () => {
  for (const format of ['png', 'jpeg', 'webp'] as const) {
    const input = await bitmap().withMetadata({ orientation: 6 }).toFormat(format).toBuffer();
    const encoded = await encodePlayerPortrait(input);
    const result = await sharp(encoded.bytes).metadata();
    assert.equal(result.width, 512); assert.equal(result.height, 512); assert.equal(result.format, 'png');
    assert.equal(result.exif, undefined); assert.equal(result.xmp, undefined); assert.equal(result.icc, undefined);
    assert.equal(encoded.sha256, createHash('sha256').update(encoded.bytes).digest('hex'));
    assert.equal(encoded.contentType, 'image/png');
  }
});
test('untrusted source formats, non-square crops and excessive actual pixels/bytes are rejected', async () => {
  for (const input of [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('GIF89a'), Buffer.from([255, 216, 255]), Buffer.alloc(PORTRAIT_MAX_INPUT_BYTES + 1), await sharp({ create: { width: 513, height: 513, channels: 3, background: 'red' } }).png().toBuffer(), await bitmap().resize(64, 32).png().toBuffer()]) {
    await assert.rejects(encodePlayerPortrait(input), PortraitInputError);
  }
});
test('base64 boundary rejects noncanonical padding, URLs, whitespace and decoded overflow', () => {
  for (const invalid of ['', 'a', 'a===', 'Zh==', 'data:image/png;base64,YQ==', 'Y Q==', Buffer.alloc(PORTRAIT_MAX_INPUT_BYTES + 1).toString('base64')]) assert.throws(() => decodePortraitBase64(invalid), PortraitInputError);
  assert.equal(decodePortraitBase64('YQ==').toString(), 'a');
  assert.equal(decodePortraitBase64(Buffer.alloc(PORTRAIT_MAX_INPUT_BYTES).toString('base64')).length, PORTRAIT_MAX_INPUT_BYTES);
});
test('local objects are immutable, private, retry-safe and removal immediately returns missing', async () => {
  const directory = await mkdtemp(join(tmpdir(), '3fc-portrait-'));
  try {
    const store = createLocalPortraitStore(directory), objectKey = key();
    const { bytes } = await encodePlayerPortrait(await bitmap().png().toBuffer());
    assert.equal(await store.get(objectKey), null);
    await Promise.all([store.put(objectKey, bytes), store.put(objectKey, bytes)]);
    assert.deepEqual(await store.get(objectKey), bytes);
    assert.equal((await stat(join(directory, objectKey))).mode & 0o777, 0o600);
    const changed = Buffer.from(bytes); changed[changed.length - 1] ^= 1;
    await assert.rejects(store.put(objectKey, changed)); assert.deepEqual(await store.get(objectKey), bytes);
    for (const invalid of ['../secret', 'portraits/../../file', objectKey.toUpperCase()]) await assert.rejects(store.get(invalid));
    const linkKey = key(); await symlink(join(directory, objectKey), join(directory, linkKey));
    await assert.rejects(store.get(linkKey));
    await store.delete(objectKey); await store.delete(objectKey); assert.equal(await store.get(objectKey), null);
    await assert.rejects(store.put(key(), bytes, AbortSignal.abort()));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('S3 immutable replay compares bytes and aborted bounded reads stop their stream', async () => {
  const { bytes } = await encodePlayerPortrait(await bitmap().png().toBuffer());
  const calls: unknown[] = []; let conflict = false; let existing = bytes;
  const client = { async send(command: GetObjectCommand | PutObjectCommand, options: { abortSignal: AbortSignal }) {
    calls.push(command); assert(options.abortSignal instanceof AbortSignal);
    if (command instanceof PutObjectCommand) {
      assert.equal(command.input.IfNoneMatch, '*'); assert.equal(command.input.CacheControl, 'no-store');
      if (conflict) throw Object.assign(new Error('exists'), { name: 'PreconditionFailed' });
      return {};
    }
    return { ContentType: 'image/png', ContentLength: existing.length, Body: Readable.from([existing]) };
  } } as unknown as S3Client;
  const store = createS3PortraitStore('private-bucket', client), objectKey = key();
  await store.put(objectKey, bytes); conflict = true; await store.put(objectKey, bytes);
  existing = Buffer.from(bytes); existing[existing.length - 1] ^= 1;
  await assert.rejects(store.put(objectKey, bytes));
  const hanging = new Readable({ read() {} });
  const blocked = createS3PortraitStore('private-bucket', { async send() { return { ContentType: 'image/png', Body: hanging }; } } as unknown as S3Client);
  const controller = new AbortController(); const read = blocked.get(objectKey, controller.signal);
  setImmediate(() => controller.abort()); await assert.rejects(read); assert.equal(hanging.destroyed, true);
  assert.equal(calls.length, 5);
});

test('orientation is applied to pixels before EXIF is stripped', async () => {
  const input = await sharp({ create: { width: 32, height: 32, channels: 3, background: 'blue' } })
    .composite([{ input: await sharp({ create: { width: 16, height: 32, channels: 3, background: 'red' } }).png().toBuffer(), left: 0, top: 0 }])
    .withMetadata({ orientation: 6 }).jpeg().toBuffer();
  const result = await encodePlayerPortrait(input);
  const { data, info } = await sharp(result.bytes).raw().toBuffer({ resolveWithObject: true });
  const top = (64 * info.width + 256) * info.channels, bottom = (448 * info.width + 256) * info.channels;
  assert(data[top] > 200 && data[top + 2] < 30);
  assert(data[bottom + 2] > 200 && data[bottom] < 30);
});
test('S3 streaming cap rejects dishonest lengths and missing objects remain empty', async () => {
  const excessive = Readable.from([Buffer.alloc(PORTRAIT_MAX_INPUT_BYTES + 1)]);
  const oversized = createS3PortraitStore('private-bucket', { async send() { return { ContentType: 'image/png', ContentLength: 20, Body: excessive }; } } as unknown as S3Client);
  await assert.rejects(oversized.get(key())); assert.equal(excessive.destroyed, true);
  const missing = createS3PortraitStore('private-bucket', { async send() { throw Object.assign(new Error(), { name: 'NoSuchKey' }); } } as unknown as S3Client);
  assert.equal(await missing.get(key()), null);
});
test('an explicitly configured symlink root is rejected even when its target is private', async () => {
  const directory = await mkdtemp(join(tmpdir(), '3fc-portrait-root-'));
  const link = `${directory}-link`;
  try {
    await symlink(directory, link);
    await assert.rejects(createLocalPortraitStore(link).get(key()));
    assert.equal(await createLocalPortraitStore(directory).get(key()), null);
  } finally {
    await rm(link, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
