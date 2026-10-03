import assert from 'node:assert/strict';
import test from 'node:test';
import { historyArguments, verifyHistoryProvenance } from '../player-history.mjs';
const cloud = ['--manifest', 'history.json', '--deployment-manifest', 'deployment.json', '--worker-manifest', 'worker.json', '--profile', '3fc-agent'];
test('history operator requires explicit context and bounded resumable steps', () => {
  assert.equal(historyArguments(['activate', ...cloud, '--apply', 'reviewed-history']).command, 'activate');
  assert.equal(historyArguments(['step', ...cloud, '--league', 'opaque/league', '--key', 'HISTORY_WORK#id', '--pages', '100', '--apply', 'reviewed-history']).pages, 100);
  assert.equal(historyArguments(['step', ...cloud, '--league', 'league', '--key', 'PLAYER_DIRECTORY', '--kind', 'directory', '--apply', 'reviewed-history']).options['--kind'], 'directory');
  assert.equal(historyArguments(['status', '--manifest', 'local.json', '--local-table', '3fc-local', '--league', 'league']).local, true);
  for (const args of [[], ['status'], ['activate', ...cloud], ['step', ...cloud, '--league', 'league', '--apply', 'reviewed-history'],
    ['status', ...cloud, '--league', 'league', '--local-table', 'local'], ['recover', ...cloud, '--league', 'league', '--kind', 'directory', '--apply', 'reviewed-history'], ['status', ...cloud, '--league', 'league', '--kind', 'other'],
    ['dry-run', ...cloud, '--league', 'league', '--apply', 'reviewed-history'],
    ['step', ...cloud, '--league', 'league', '--key', 'key', '--pages', '101', '--apply', 'reviewed-history']]) assert.throws(() => historyArguments(args));
});
function provenance() {
  const hash = `${'A'.repeat(43)}=`, sha = 'a'.repeat(40);
  return { manifest: { version: 1, writerVersion: 1, ruleVersion: 1, writerSha: sha, accountId: '123456789012', region: 'ap-southeast-2', tableName: '3fc-qa-app', drainedAt: '2026-10-03T00:16:00Z' },
    deployment: { env: 'qa', service: 'api-core', gitCommit: sha, region: 'ap-southeast-2', packageCodeSha256: hash,
      functionFingerprint: { functionName: '3fc-qa-api-core', codeSha256: hash, revisionId: 'revision', playerClaimMode: 'proof' } },
    caller: { Account: '123456789012' }, table: { TableArn: 'arn:aws:dynamodb:ap-southeast-2:123456789012:table/3fc-qa-app', TableName: '3fc-qa-app', TableStatus: 'ACTIVE' },
    live: { functionName: '3fc-qa-api-core', codeSha256: hash, revisionId: 'revision', state: 'Active', lastUpdateStatus: 'Successful', tableName: '3fc-qa-app', claimMode: 'proof', lastModified: '2026-10-03T00:00:00Z', timeout: 10 },
    now: Date.parse('2026-10-03T00:17:00Z') };
}
test('profile work uses the same guarded local/cloud runner with bounded exact-player recovery', () => {
  const key = 'NAME#00000000-0000-4000-8000-000000000000';
  assert.equal(historyArguments(['profile-status', ...cloud, '--player', 'opaque/player']).command, 'profile-status');
  assert.equal(historyArguments(['profile-status', '--manifest', 'local.json', '--local-table', '3fc-local', '--player', 'p']).local, true);
  assert.equal(historyArguments(['profile-step', ...cloud, '--player', 'p', '--key', key, '--pages', '100', '--apply', 'reviewed-history']).pages, 100);
  for (const args of [
    ['profile-status', ...cloud], ['profile-status', ...cloud, '--player', 'p', '--league', 'league'],
    ['profile-step', ...cloud, '--player', 'p', '--key', key],
    ['profile-step', ...cloud, '--player', 'p', '--key', 'HISTORY_WORK#other', '--apply', 'reviewed-history'],
    ['profile-step', ...cloud, '--player', 'p', '--key', key, '--pages', '101', '--apply', 'reviewed-history'],
    ['profile-status', ...cloud, '--player', 'p', '--kind', 'player'],
  ]) assert.throws(() => historyArguments(args));
});
test('history activation binds rule/writer version, exact account/table/code and old-writer drain', () => {
  verifyHistoryProvenance(provenance());
  for (const [part, field, value] of [['manifest', 'ruleVersion', 2], ['manifest', 'writerVersion', 2], ['manifest', 'version', 2],
    ['caller', 'Account', 'other'], ['manifest', 'drainedAt', '2026-10-03T00:00:10Z'], ['manifest', 'drainedAt', '2026-10-04T00:00:00Z'],
    ['live', 'tableName', '3fc-prod-app'], ['live', 'revisionId', 'changed'], ['live', 'codeSha256', 'changed']]) {
    const fixture = provenance(); fixture[part][field] = value; assert.throws(() => verifyHistoryProvenance(fixture), `${part}.${field}`);
  }
});
