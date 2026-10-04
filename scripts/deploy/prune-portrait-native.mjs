#!/usr/bin/env node
// This runs only inside serverless-esbuild's disposable dependency tree, after
// npm's cross-platform install. npm can retain the CI host's optional binaries.
import assert from 'node:assert/strict';
import { lstat, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const retained = new Set(['sharp-linux-arm64', 'sharp-libvips-linux-arm64', 'sharp-wasm32']);

export async function prunePortraitNative(buildDirectory, serviceDirectory = repository) {
  const service = await realpath(serviceDirectory);
  const expected = join(service, '.esbuild', '.build');
  assert.equal(await realpath(buildDirectory), expected, 'Refusing to prune outside the generated core dependency tree');
  // Check every managed path before any deletion; symlinks cannot redirect cleanup.
  for (const path of [join(service, '.esbuild'), expected, join(expected, 'node_modules'), join(expected, 'node_modules', '@img')]) {
    const stat = await lstat(path);
    assert(stat.isDirectory() && !stat.isSymbolicLink(), `Expected a real generated directory: ${path}`);
  }
  const generated = JSON.parse(await readFile(join(expected, 'package.json'), 'utf8'));
  assert.equal(generated.name, 'threefc-api-core', 'Only the generated core package can be pruned');
  assert.equal(generated.private, true);
  assert(['0.35.5', '^0.35.5'].includes(generated.dependencies?.sharp), 'Unexpected generated sharp dependency');
  const directory = join(expected, 'node_modules', '@img');
  const entries = await readdir(directory, { withFileTypes: true });
  const foreign = entries.filter(entry => entry.name.startsWith('sharp-') && !retained.has(entry.name));
  for (const entry of foreign) assert(entry.isDirectory() && !entry.isSymbolicLink(), `Unexpected native package entry: ${entry.name}`);
  for (const entry of foreign) await rm(join(directory, entry.name), { recursive: true });
  return foreign.map(entry => entry.name).sort();
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const removed = await prunePortraitNative(process.cwd());
  console.log(`[deploy] Removed foreign native packages from generated core tree: ${removed.join(', ') || 'none'}`);
}
