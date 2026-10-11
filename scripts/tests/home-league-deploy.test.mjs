import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkHomeLookupDeployment } from '../deploy/check-home-lookup-compatibility.mjs';

const head = 'a'.repeat(40);
test('core deployment derives runtime writer from checkout instead of caller input', async () => {
  const source = await readFile('scripts/deploy/deploy-app.sh', 'utf8');
  const start = source.indexOf('if [[ "$SERVICE" == "api-core" ]]; then');
  const stop = source.indexOf('\n# Both producer', start);
  const directory = await mkdtemp(join(tmpdir(), '3fc-writer-deploy-'));
  try {
    await writeFile(join(directory, 'git'), `#!/bin/sh\nprintf '%s' '${head}'\n`, { mode: 0o755 });
    const run = spawnSync('bash', ['-c', `set -euo pipefail\nconfigure_player_claim_mode() { :; }\n${source.slice(start, stop)}\nnode -e 'process.stdout.write(process.env.API_WRITER_SHA)'`],
      { encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, SERVICE: 'api-core', ENV: 'qa', DYNAMODB_TABLE: '3fc-qa-app', API_WRITER_SHA: 'b'.repeat(40) } });
    assert.equal(run.status, 0, run.stderr); assert.equal(run.stdout, head);
    assert.match(await readFile('serverless.api-core.yml', 'utf8'), /API_WRITER_SHA: \$\{env:API_WRITER_SHA\}/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('final deployment guard rejects replaced or missing runtime writer identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), '3fc-writer-fingerprint-'));
  try {
    await mkdir(join(directory, 'out/deploy/qa'), { recursive: true });
    const fingerprint = { functionName: '3fc-qa-api-core', lastUpdateStatus: 'Successful', codeSha256: 'accepted-package', revisionId: 'accepted-revision',
      playerClaimMode: 'proof', consolidationEnabled: 'false', returningJoinEnabled: 'false', profilesEnabled: 'false', achievementsEnabled: 'false',
      ownerEditingEnabled: 'false', historyProcessingEnabled: 'false', portraitBucket: '3fc-qa-portraits-301691475109', apiWriterSha: head, homeLookupWriterVersion: '1',
      runtime: 'nodejs22.x', architectures: ['arm64'], timeout: 28 };
    const manifest = { gitCommit: head, env: 'qa', service: 'api-core', region: 'ap-southeast-2', packageCodeSha256: fingerprint.codeSha256, functionFingerprint: fingerprint };
    await writeFile(join(directory, 'out/deploy/qa/api-core-deploy-manifest.json'), JSON.stringify(manifest));
    await writeFile(join(directory, 'aws'), '#!/usr/bin/env node\nprocess.stdout.write(process.env.FAKE_LIVE);\n', { mode: 0o755 });
    const run = live => spawnSync('bash', [resolve('scripts/deploy/verify-api-core.sh'), 'qa', head], { cwd: directory, encoding: 'utf8',
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, FAKE_LIVE: JSON.stringify(live) } });
    assert.equal(run(fingerprint).status, 0);
    assert.notEqual(run({ ...fingerprint, apiWriterSha: 'b'.repeat(40) }).status, 0);
    const missing = { ...fingerprint }; delete missing.apiWriterSha;
    assert.notEqual(run(missing).status, 0);
    await writeFile(join(directory, 'out/deploy/qa/api-core-deploy-manifest.json'), JSON.stringify({ ...manifest, functionFingerprint: missing }));
    assert.notEqual(run(missing).status, 0, 'missing manifest and runtime identity must not compare equal');
  } finally { await rm(directory, { recursive: true, force: true }); }
});


function controls(coverage, reader) {
  const item = (value, type) => value === undefined ? {} : { Item: { entityType: { S: type }, data: { S: JSON.stringify(value) } } };
  return { send: async () => ({ Responses: [item(coverage, 'homeLeagueCoverage'), item(reader, 'homeLeagueReader')] }) };
}
const coverage = { version: 1, epoch: 'test-epoch', phase: 'ready', cursor: null, pages: 2, repaired: 1, verified: 1,
  manifest: { migrationId: 'home-test-qa', accountId: '123456789012', region: 'ap-southeast-2', tableName: '3fc-qa-app',
    tableArn: 'arn:aws:dynamodb:ap-southeast-2:123456789012:table/3fc-qa-app', writerSha: head, writerVersion: 1,
    reviewedPlan: 'https://github.com/ajfisher/3fc/pull/237', drainedAt: '2026-10-10T00:00:00Z' } };
const reader = { version: 1, enabled: true, coverageEpoch: coverage.epoch };
const live = { tableName: '3fc-qa-app', apiWriterSha: 'b'.repeat(40), homeLookupWriterVersion: '1', state: 'Active', status: 'Successful' };

test('deployment allows compatible commits and requires disabled reader AND coverage for an incompatible contract', async () => {
  await checkHomeLookupDeployment(controls(coverage, reader), '3fc-qa-app', async () => live);
  for (const [key, value] of [['homeLookupWriterVersion', '2'], ['homeLookupWriterVersion', undefined], ['apiWriterSha', undefined],
    ['tableName', '3fc-prod-app'], ['state', 'Pending'], ['status', 'InProgress']])
    await assert.rejects(checkHomeLookupDeployment(controls(coverage, reader), '3fc-qa-app', async () => ({ ...live, [key]: value })));
  const incompatible = { ...coverage, manifest: { ...coverage.manifest, writerVersion: 2 } };
  await assert.rejects(checkHomeLookupDeployment(controls(incompatible, reader), '3fc-qa-app', async () => live));
  await assert.rejects(checkHomeLookupDeployment(controls(incompatible, { ...reader, enabled: false }), '3fc-qa-app', async () => live));
  await assert.rejects(checkHomeLookupDeployment(controls({ ...incompatible, phase: 'disabled' }, reader), '3fc-qa-app', async () => live));
  const noRead = async () => { throw new Error('disabled controls must not read a live writer'); };
  await checkHomeLookupDeployment(controls({ ...incompatible, phase: 'disabled' }, { ...reader, enabled: false, coverageEpoch: null }), '3fc-qa-app', noRead);
  await checkHomeLookupDeployment(controls(undefined, undefined), '3fc-qa-app', noRead);
});

test('deployment refuses malformed, incomplete and inconsistent controls', async () => {
  for (const value of [null, [], {}, 'invalid']) {
    await assert.rejects(checkHomeLookupDeployment(controls(value, undefined), '3fc-qa-app', async () => live));
    await assert.rejects(checkHomeLookupDeployment(controls(undefined, value), '3fc-qa-app', async () => live));
  }
  for (const phase of ['backfill', 'verification'])
    await assert.rejects(checkHomeLookupDeployment(controls({ ...coverage, phase }, undefined), '3fc-qa-app', async () => live));
  await assert.rejects(checkHomeLookupDeployment(controls(coverage, { ...reader, coverageEpoch: 'wrong' }), '3fc-qa-app', async () => live));
  for (const type of ['homeLeagueCoverage', 'homeLeagueReader']) {
    const missing = { send: async () => ({ Responses: ['homeLeagueCoverage', 'homeLeagueReader'].map(name => name === type ? { Item: { entityType: { S: name } } } : {}) }) };
    await assert.rejects(checkHomeLookupDeployment(missing, '3fc-qa-app', async () => live));
  }
});

test('API deployment rejects a table override before preflight or cloud deployment', async () => {
  const source = await readFile('scripts/deploy/deploy-app.sh', 'utf8');
  const start = source.indexOf('if [[ "$SERVICE" == "api-core" ]]; then');
  const stop = source.indexOf('\n# Both producer', start);
  const run = spawnSync('bash', ['-c', `set -euo pipefail\n${source.slice(start, stop)}`],
    { encoding: 'utf8', env: { ...process.env, SERVICE: 'api-core', ENV: 'qa', DYNAMODB_TABLE: 'other-app' } });
  assert.notEqual(run.status, 0); assert.match(run.stderr, /selected environment/);
});
