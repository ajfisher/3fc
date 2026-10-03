#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function verifyPortraitPackage(entries) {
  const paths = new Set(entries);
  for (const required of [
    'node_modules/sharp/package.json', 'node_modules/sharp/dist/index.cjs', 'node_modules/sharp/dist/index.mjs',
    'node_modules/@img/sharp-linux-arm64/package.json', 'node_modules/@img/sharp-linux-arm64/index.cjs',
    'node_modules/@img/sharp-linux-arm64/lib/sharp-linux-arm64-0.35.5.node',
    'node_modules/@img/sharp-libvips-linux-arm64/package.json', 'node_modules/@img/sharp-libvips-linux-arm64/lib/index.js'
  ]) {
    assert(paths.has(required), `Missing Lambda dependency: ${required}`);
  }
  assert(entries.some(path => /^node_modules\/@img\/sharp-libvips-linux-arm64\/lib\/libvips-cpp\.so\.\d+(?:\.\d+)*$/.test(path)), 'Missing Linux arm64 libvips');
  assert(!entries.some(path => /node_modules\/@img\/sharp-(?:libvips-)?(?:darwin|win32|linux-x64|linuxmusl)/.test(path)), 'Unexpected native platform in Lambda artifact');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const zip = process.argv[2]; assert(zip, 'Expected core ZIP path');
  verifyPortraitPackage(execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n'));
  console.log('[deploy] Processed portrait Linux arm64 dependencies are packaged.');
}
