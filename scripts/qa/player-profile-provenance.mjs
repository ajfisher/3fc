// QA-only operator preflight. No production override or credential output.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { readHistorySnapshot, verifyHistoryManifest } from '../deploy/verify-player-history.mjs';

export const QA_PROFILE_SCOPE = Object.freeze({ profile: '3fc-agent', accountId: '301691475109',
  region: 'ap-southeast-2', tableName: '3fc-qa-app', portraitBucket: '3fc-qa-portraits-301691475109' });
const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const fingerprintQuery = '{tableName:Environment.Variables.DYNAMODB_TABLE,state:State,functionName:FunctionName,codeSha256:CodeSha256,revisionId:RevisionId,lastUpdateStatus:LastUpdateStatus,playerClaimMode:Environment.Variables.PLAYER_CLAIM_MODE,consolidationEnabled:Environment.Variables.PLAYER_CONSOLIDATION_ENABLED,returningJoinEnabled:Environment.Variables.PLAYER_RETURNING_JOIN_ENABLED,profilesEnabled:Environment.Variables.PLAYER_PROFILES_ENABLED,achievementsEnabled:Environment.Variables.PLAYER_ACHIEVEMENTS_ENABLED,ownerEditingEnabled:Environment.Variables.PLAYER_OWNER_EDITING_ENABLED,historyProcessingEnabled:Environment.Variables.HISTORY_PROCESSING_ENABLED,portraitBucket:Environment.Variables.PORTRAIT_BUCKET,apiWriterSha:Environment.Variables.API_WRITER_SHA,runtime:Runtime,architectures:Architectures,timeout:Timeout}';
const execute = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8',
  timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
const aws = (...args) => JSON.parse(execute('aws', [...args, '--profile', QA_PROFILE_SCOPE.profile,
  '--region', QA_PROFILE_SCOPE.region, '--output', 'json']));

/** Pure boundary tests cannot accidentally launch a cloud operation. */
export function assertQaProfileEvidence({ head, run, checks, caller, core, workers, live, requireFeatures = false }) {
  assert(/^[a-f0-9]{40}$/.test(head), 'Expected full reviewed head');
  assert.equal(run.repository?.full_name, 'ajfisher/3fc');
  assert.equal(run.name, 'Deploy QA'); assert.equal(run.head_sha, head);
  assert.equal(run.status, 'completed'); assert.equal(run.conclusion, 'success');
  // A previous passing check cannot hide a later pending/cancelled rerun.
  for (const name of ['merge-gate', 'review-gate']) {
    const current = checks.filter(check => check.name === name).sort((a, b) => b.id - a.id)[0];
    assert.equal(current?.head_sha, head); assert.equal(current?.status, 'completed');
    assert.equal(current?.conclusion, 'success', `Current-head ${name} must pass`);
  }
  assert.equal(caller.Account, QA_PROFILE_SCOPE.accountId);
  assert.equal(core.env, 'qa'); assert.equal(core.service, 'api-core'); assert.equal(core.gitCommit, head);
  assert.equal(core.region, QA_PROFILE_SCOPE.region);
  assert.equal(workers.env, 'qa'); assert.equal(workers.gitCommit, head);
  for (const field of ['accountId', 'region', 'tableName', 'portraitBucket']) assert.equal(workers[field], QA_PROFILE_SCOPE[field]);
  const recorded = core.functionFingerprint;
  assert.equal(recorded?.functionName, '3fc-qa-api-core');
  assert(/^[A-Za-z0-9+/]{43}=$/.test(core.packageCodeSha256 ?? ''));
  assert.equal(recorded.codeSha256, core.packageCodeSha256);
  assert(typeof recorded.revisionId === 'string' && recorded.revisionId.length > 0);
  assert.equal(recorded.lastUpdateStatus, 'Successful');
  assert.equal(recorded.apiWriterSha, head);
  const { tableName, state, ...fingerprint } = live;
  assert.equal(tableName, QA_PROFILE_SCOPE.tableName); assert.equal(state, 'Active'); assert.deepEqual(fingerprint, recorded);
  assert.equal(recorded.playerClaimMode, 'proof'); assert.equal(recorded.runtime, 'nodejs22.x');
  assert.deepEqual(recorded.architectures, ['arm64']); assert.equal(recorded.timeout, 28);
  assert.equal(recorded.portraitBucket, QA_PROFILE_SCOPE.portraitBucket);
  for (const field of ['consolidationEnabled', 'returningJoinEnabled', 'profilesEnabled', 'achievementsEnabled', 'ownerEditingEnabled', 'historyProcessingEnabled'])
    assert(['true', 'false'].includes(recorded[field]), 'Explicit feature state required');
  assert.equal(recorded.historyProcessingEnabled, workers.processingEnabled);
  if (requireFeatures) for (const field of ['profilesEnabled', 'achievementsEnabled', 'ownerEditingEnabled', 'historyProcessingEnabled'])
    assert.equal(recorded[field], 'true', 'Complete feature must be enabled for acceptance');
}

export function assertQaProfileReadiness(readiness, head) {
  assert.equal(readiness.enabled, true); assert.equal(readiness.ruleVersion, 1);
  assert.equal(readiness.manifest.writerSha, head); assert.equal(readiness.manifest.writerVersion, 1);
  assert.equal(readiness.manifest.ruleVersion, 1);
  for (const field of ['accountId', 'region', 'tableName']) assert.equal(readiness.manifest[field], QA_PROFILE_SCOPE[field]);
}

/** Wrap the entire invocation in the resource guard: it includes a fresh API build. */
export async function verifyQaProvenance(options) { return verifyQaProvenanceOnce(options, true); }
async function verifyQaProvenanceOnce({ head, runId, requireFeatures = false }, buildRuntime) {
  let directory;
  try {
    assert(/^[a-f0-9]{40}$/.test(head) && /^\d+$/.test(String(runId)), 'Explicit head and QA run required');
    assert.equal(resolve(process.cwd()), root);
    assert.equal(execute('git', ['rev-parse', 'HEAD']).trim(), head);
    assert.equal(execute('git', ['status', '--porcelain', '--untracked-files=no']).trim(), '');
    assert.equal(execute('git', ['ls-files', '--others', '--exclude-standard', '--', 'api/src', 'packages/contracts/src', 'scripts']).trim(), '');
    const run = JSON.parse(execute('gh', ['api', `repos/ajfisher/3fc/actions/runs/${runId}`]));
    const checks = JSON.parse(execute('gh', ['api', '--paginate', '--slurp',
      `repos/ajfisher/3fc/commits/${head}/check-runs?per_page=100`])).flatMap(page => page.check_runs);
    directory = await mkdtemp(join(tmpdir(), '3fc-profile-qa-evidence-'));
    execute('gh', ['run', 'download', String(runId), '--repo', 'ajfisher/3fc', '--name', 'qa-api-core-deployment', '--dir', directory]);
    const core = JSON.parse(await readFile(join(directory, 'api-core-deploy-manifest.json'), 'utf8'));
    const workers = JSON.parse(await readFile(join(directory, 'player-history-deploy-manifest.json'), 'utf8'));
    const caller = aws('sts', 'get-caller-identity');
    const live = aws('lambda', 'get-function-configuration', '--function-name', '3fc-qa-api-core', '--query', fingerprintQuery);
    assertQaProfileEvidence({ head, run, checks, caller, core, workers, live, requireFeatures });
    // Validate artifact scope before issuing any artifact-directed cloud reads.
    process.env.AWS_PROFILE = QA_PROFILE_SCOPE.profile;
    verifyHistoryManifest(workers, workers.snapshot, 'qa', head);
    verifyHistoryManifest(workers, readHistorySnapshot(workers), 'qa', head);
    if (buildRuntime) execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--build', 'api/tsconfig.json', '--force'],
      { cwd: root, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const { PlayerIdentityPlanner } = await import('../../api/dist/data/player-identity.js');
    const client = new DynamoDBClient({ region: QA_PROFILE_SCOPE.region, profile: QA_PROFILE_SCOPE.profile });
    try {
      const identity = new PlayerIdentityPlanner(client, QA_PROFILE_SCOPE.tableName);
      identity.requireCoverage(await identity.readControl());
      if (requireFeatures) {
        const { readHistoryReadiness } = await import('../../api/dist/data/player-history-readiness.js');
        const readiness = await readHistoryReadiness(client, QA_PROFILE_SCOPE.tableName);
        assertQaProfileReadiness(readiness.value, head);
      }
    } finally { client.destroy(); }
    return { head, ...QA_PROFILE_SCOPE, core, workers,
      recheck: () => verifyQaProvenanceOnce({ head, runId, requireFeatures }, false) };
  } catch {
    // Never serialize SDK/child-process diagnostics, environment or auth records.
    throw new Error('QA provenance failed: verify SSO, clean exact head, passing gates, deployment artifacts, live fingerprints and readiness.');
  } finally { if (directory) await rm(directory, { recursive: true, force: true }); }
}
