import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { verifyPortraitPackage } from '../deploy/verify-portrait-package.mjs';
const source = file => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
test('core artifact must contain native Linux arm64 sharp and libvips', () => {
  // Entry names inspected in the actual sharp0.35.5 Linux arm64 package proof ZIP.
  const entries = ['api/src/lambda-core.js',
    'node_modules/sharp/package.json', 'node_modules/sharp/dist/index.cjs', 'node_modules/sharp/dist/index.mjs',
    'node_modules/@img/sharp-linux-arm64/package.json', 'node_modules/@img/sharp-linux-arm64/index.cjs',
    'node_modules/@img/sharp-linux-arm64/lib/sharp-linux-arm64-0.35.5.node',
    'node_modules/@img/sharp-libvips-linux-arm64/package.json', 'node_modules/@img/sharp-libvips-linux-arm64/lib/index.js',
    'node_modules/@img/sharp-libvips-linux-arm64/lib/libvips-cpp.so.8.18.7'];
  verifyPortraitPackage(entries);
  for (const required of entries.slice(1)) assert.throws(() => verifyPortraitPackage(entries.filter(path => path !== required)));
  assert.throws(() => verifyPortraitPackage([...entries, 'node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64.node']));
});
test('only processed private objects are allowed and cleanup has no write or read grant', () => {
  const tf = source('infra/application/player-portrait.tf');
  for (const flag of ['block_public_acls', 'block_public_policy', 'ignore_public_acls', 'restrict_public_buckets']) assert.match(tf, new RegExp(`${flag}\\s*= true`));
  assert.match(tf, /BucketOwnerEnforced/); assert.match(tf, /AES256/); assert.match(tf, /aws:SecureTransport/);
  assert.match(tf, /force_destroy\s*= false/);
  const core = tf.split('resource "aws_iam_role_policy" "player_portrait_core"')[1].split('resource "aws_iam_role_policy" "player_portrait_cleanup"')[0];
  assert.match(core, /\["s3:GetObject", "s3:PutObject"\]/); assert.doesNotMatch(core, /DeleteObject|ListBucket/);
  const worker = tf.split('resource "aws_iam_role_policy" "player_portrait_cleanup"')[1];
  assert.match(worker, /\["s3:DeleteObject"\]/); assert.doesNotMatch(worker, /GetObject|PutObject|ListBucket/);
  assert.match(core, /\/portraits\/\*/); assert.match(worker, /\/portraits\/\*/);
});
test('native packaging is checked before deploying the exact prepared artifact', () => {
  const core = source('serverless.api-core.yml');
  assert.match(core, /runtime: nodejs22.x/); assert.match(core, /architecture: arm64/);
  assert.match(core, /packagePath: .\/api\/package.json/); assert.match(core, /external:\s+- sharp/);
  assert.match(core, /npm install --os=linux --libc=glibc --cpu=arm64 --include=optional sharp@0.35.5/);
  const deploy = source('scripts/deploy/deploy-app.sh');
  const pack = deploy.indexOf('npx serverless package');
  const check = deploy.indexOf('node scripts/deploy/verify-portrait-package.mjs');
  const publish = deploy.indexOf('npx serverless deploy --package .serverless');
  assert(pack >= 0 && pack < check && check < publish);
  assert.match(source('compose.yaml'), /PORTRAIT_LOCAL_DIRECTORY: "\/workspace\/local\/portraits"/);
  assert.match(source('.gitignore'), /local\/portraits\/\*/);
});
