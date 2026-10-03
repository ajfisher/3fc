import assert from 'node:assert/strict';
import test from 'node:test';
import { assertQaProfileEvidence, assertQaProfileReadiness, QA_PROFILE_SCOPE } from '../qa/player-profile-provenance.mjs';

function evidence(enabled = true) {
  const head = 'a'.repeat(40), state = String(enabled);
  const live = { functionName: '3fc-qa-api-core', codeSha256: `${'A'.repeat(43)}=`, revisionId: 'revision',
    lastUpdateStatus: 'Successful', playerClaimMode: 'proof', consolidationEnabled: 'true', returningJoinEnabled: 'true',
    profilesEnabled: state, achievementsEnabled: state, ownerEditingEnabled: state, historyProcessingEnabled: state,
    portraitBucket: QA_PROFILE_SCOPE.portraitBucket, runtime: 'nodejs22.x', architectures: ['arm64'], timeout: 28 };
  return { head, run: { repository: { full_name: 'ajfisher/3fc' }, name: 'Deploy QA', head_sha: head, status: 'completed', conclusion: 'success' },
    checks: ['merge-gate', 'review-gate'].map((name, index) => ({ name, id: index + 1, head_sha: head, status: 'completed', conclusion: 'success' })),
    caller: { Account: QA_PROFILE_SCOPE.accountId },
    core: { env: 'qa', service: 'api-core', gitCommit: head, region: QA_PROFILE_SCOPE.region, packageCodeSha256: live.codeSha256, functionFingerprint: structuredClone(live) },
    workers: { ...QA_PROFILE_SCOPE, env: 'qa', gitCommit: head, processingEnabled: state }, live: { ...live, tableName: QA_PROFILE_SCOPE.tableName, state: 'Active' }, requireFeatures: enabled };
}

test('QA provenance allows disabled inventory and enabled acceptance without changing existing feature switches', () => {
  assertQaProfileEvidence(evidence(false)); assertQaProfileEvidence(evidence(true));
  const disabled = evidence(false); disabled.requireFeatures = true;
  assert.throws(() => assertQaProfileEvidence(disabled));
});

test('QA provenance rejects stale head, incomplete current gates and newer cancelled or pending reruns', () => {
  for (const target of ['run', 'core', 'workers']) {
    const value = evidence(); value[target][target === 'run' ? 'head_sha' : 'gitCommit'] = 'b'.repeat(40);
    assert.throws(() => assertQaProfileEvidence(value));
  }
  for (const name of ['merge-gate', 'review-gate']) {
    for (const conclusion of ['cancelled', 'neutral', 'skipped', 'failure', null]) {
      const value = evidence();
      value.checks.push({ id: 50, name, head_sha: value.head, status: conclusion === null ? 'in_progress' : 'completed', conclusion });
      assert.throws(() => assertQaProfileEvidence(value));
    }
    const value = evidence(); value.checks = value.checks.filter(check => check.name !== name);
    assert.throws(() => assertQaProfileEvidence(value));
  }
  for (const patch of [{ status: 'in_progress' }, { conclusion: 'failure' }, { name: 'Deploy Production' }, { repository: { full_name: 'other/3fc' } }]) {
    const value = evidence(); Object.assign(value.run, patch); assert.throws(() => assertQaProfileEvidence(value));
  }
});

test('QA provenance rejects account table region media or worker scope drift before artifact-directed AWS reads', () => {
  for (const field of ['accountId', 'region', 'tableName', 'portraitBucket', 'env', 'processingEnabled']) {
    const value = evidence(); value.workers[field] = 'wrong'; assert.throws(() => assertQaProfileEvidence(value));
  }
  const caller = evidence(); caller.caller.Account = '000000000000'; assert.throws(() => assertQaProfileEvidence(caller));
  for (const field of ['env', 'service', 'region', 'packageCodeSha256']) {
    const value = evidence(); value.core[field] = ''; assert.throws(() => assertQaProfileEvidence(value));
  }
});

test('QA provenance rejects missing fields and live fingerprint changes even for the same accepted commit', () => {
  for (const field of Object.keys(evidence().live)) {
    const value = evidence(); delete value.live[field]; assert.throws(() => assertQaProfileEvidence(value), field);
  }
  for (const patch of [{ revisionId: '' }, { functionName: '3fc-prod-api-core' }, { playerClaimMode: 'disabled' }, { runtime: 'nodejs20.x' }, { timeout: 10 }, { architectures: ['x86_64'] }]) {
    const value = evidence(); Object.assign(value.live, patch); Object.assign(value.core.functionFingerprint, patch);
    assert.throws(() => assertQaProfileEvidence(value));
  }
  for (const field of ['profilesEnabled', 'achievementsEnabled', 'ownerEditingEnabled', 'historyProcessingEnabled']) {
    const value = evidence(); value.live[field] = 'false'; value.core.functionFingerprint[field] = 'false';
    if (field === 'historyProcessingEnabled') value.workers.processingEnabled = 'false';
    assert.throws(() => assertQaProfileEvidence(value));
  }
});

test('acceptance requires readiness activated for this final head and exact QA scope', () => {
  const head = 'a'.repeat(40), readiness = { enabled: true, ruleVersion: 1,
    manifest: { ...QA_PROFILE_SCOPE, writerSha: head, writerVersion: 1, ruleVersion: 1 } };
  assertQaProfileReadiness(readiness, head);
  for (const field of ['writerSha', 'accountId', 'region', 'tableName', 'writerVersion', 'ruleVersion']) {
    const changed = structuredClone(readiness); changed.manifest[field] = field === 'writerSha' ? 'b'.repeat(40) : 'wrong';
    assert.throws(() => assertQaProfileReadiness(changed, head));
  }
});
