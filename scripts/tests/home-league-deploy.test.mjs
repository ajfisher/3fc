import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const head = 'a'.repeat(40);
test('core deployment derives runtime writer from checkout instead of caller input', async () => {
  const source = await readFile('scripts/deploy/deploy-app.sh', 'utf8');
  const start = source.indexOf('if [[ "$SERVICE" == "api-core" ]]; then');
  const stop = source.indexOf('\n# Both producer', start);
  const directory = await mkdtemp(join(tmpdir(), '3fc-writer-deploy-'));
  try {
    await writeFile(join(directory, 'git'), `#!/bin/sh\nprintf '%s' '${head}'\n`, { mode: 0o755 });
    const run = spawnSync('bash', ['-c', `set -euo pipefail\nconfigure_player_claim_mode() { :; }\n${source.slice(start, stop)}\nnode -e 'process.stdout.write(process.env.API_WRITER_SHA)'`],
      { encoding: 'utf8', env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, SERVICE: 'api-core', API_WRITER_SHA: 'b'.repeat(40) } });
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
      ownerEditingEnabled: 'false', historyProcessingEnabled: 'false', portraitBucket: '3fc-qa-portraits-301691475109', apiWriterSha: head,
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
