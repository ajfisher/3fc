import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { verifyHistoryDeploymentFreeze, stuckProductionRun } from '../player-history-deployment-freeze.mjs';
import { historyArguments } from '../player-history.mjs';
import { verifyProductionHead } from '../deploy/verify-production-head.mjs';

const sha = 'a'.repeat(40), repo = 'repos/ajfisher/3fc';
const workflow = `${repo}/actions/workflows/deploy-prod.yml`;
const runPath = `${repo}/actions/runs/${stuckProductionRun.id}`;
function fixture() {
  const responses = new Map([
    [workflow, { id: 237189056, state: 'disabled_manually' }],
    [runPath, { id: 37241624452, workflow_id: 237189056, path: '.github/workflows/deploy-prod.yml',
      event: 'workflow_dispatch', head_branch: 'main', head_sha: stuckProductionRun.sha, run_attempt: 1,
      status: 'queued', conclusion: null, repository: { full_name: 'ajfisher/3fc' }, head_repository: { full_name: 'ajfisher/3fc' } }],
    [`${runPath}/attempts/1/jobs?per_page=1`, { total_count: 0, jobs: [] }],
  ]);
  for (const state of ['queued', 'in_progress', 'waiting', 'pending', 'requested'])
    responses.set(`${workflow}/runs?status=${state}&per_page=1`, { total_count: state === 'queued' ? 1 : 0,
      workflow_runs: state === 'queued' ? [{ id: 37241624452, status: 'queued' }] : [] });
  const input = { env: 'prod', writerSha: sha, excludedRun: '37241624452',
    readGithub: path => { assert(responses.has(path), path); return structuredClone(responses.get(path)); },
    readGit: args => {
      if (args[0] === 'ls-remote') {
        assert.deepEqual(args, ['ls-remote', '--exit-code', 'https://github.com/ajfisher/3fc.git', 'refs/heads/main']);
        return `${sha}\trefs/heads/main\n`;
      }
      assert.equal(args[0], 'show'); assert(args[1].startsWith(`${stuckProductionRun.sha}:`));
      // These checked-in files still match the pinned historical hashes. A future
      // deployment-guard change must retain the incident evidence as a fixture.
      return readFileSync(new URL(`../../${args[1].split(':')[1]}`, import.meta.url), 'utf8');
    } };
  return { input, responses };
}

test('explicit incident exception admits only the queued jobless run after main advances', () => {
  const { input } = fixture();
  assert.doesNotThrow(() => verifyHistoryDeploymentFreeze(input));
  // The guard whose bytes the exception pins refuses this very same run at the
  // accepted new main, before its workflow reaches credential configuration.
  assert.throws(() => verifyProductionHead({ event: 'workflow_dispatch', ref: 'refs/heads/main',
    eventSha: stuckProductionRun.sha, checkoutSha: stuckProductionRun.sha,
    expectedSha: stuckProductionRun.sha, remoteMain: sha }));
});

test('default freeze still requires zero pending runs, including the incident run', () => {
  const { input, responses } = fixture(); delete input.excludedRun;
  assert.throws(() => verifyHistoryDeploymentFreeze(input), /Drain pending/);
  responses.set(`${workflow}/runs?status=queued&per_page=1`, { total_count: 0, workflow_runs: [] });
  assert.doesNotThrow(() => verifyHistoryDeploymentFreeze(input));
});

test('exception rejects a different environment, ID, old writer, changed main or changed guard', () => {
  for (const change of [
    input => { input.env = 'qa'; input.readGithub = () => ({ id: 237189056, state: 'disabled_manually' }); },
    input => { input.excludedRun = '37248306294'; },
    input => { input.writerSha = stuckProductionRun.sha; },
    input => { input.writerSha = 'not-a-sha'; },
    input => { input.readGit = () => `${stuckProductionRun.sha}\trefs/heads/main`; },
    input => { input.readGit = () => `${'b'.repeat(40)}\trefs/heads/main`; },
    input => { const read = input.readGit; input.readGit = args => args[0] === 'show' ? 'changed workflow' : read(args); },
    input => { input.readGit = () => { throw new Error('git unavailable'); }; },
    input => { input.readGithub = () => { throw new Error('GitHub unavailable'); }; },
  ]) {
    const { input } = fixture(); change(input); assert.throws(() => verifyHistoryDeploymentFreeze(input));
  }
});

test('run identity, attempts and job evidence must remain exactly as reviewed', () => {
  for (const overrides of [{ id: 1 }, { workflow_id: 1 }, { path: 'another.yml' }, { event: 'push' },
    { head_branch: 'another' }, { head_sha: sha }, { run_attempt: 2 }, { status: 'in_progress' },
    { status: 'completed', conclusion: 'cancelled' }, { conclusion: 'success' },
    { repository: { full_name: 'someone/3fc' } }, { head_repository: null }]) {
    const { input, responses } = fixture(); Object.assign(responses.get(runPath), overrides);
    assert.throws(() => verifyHistoryDeploymentFreeze(input), /changed state or identity/);
  }
  for (const jobs of [{}, { total_count: 1, jobs: [] }, { total_count: 0, jobs: [{ id: 1 }] }, { total_count: 0 }]) {
    const { input, responses } = fixture(); responses.set(`${runPath}/attempts/1/jobs?per_page=1`, jobs);
    assert.throws(() => verifyHistoryDeploymentFreeze(input), /with jobs/);
  }
});

test('enabled workflow and every other pending deployment block, including hidden pages', () => {
  for (const state of ['active', 'disabled_inactivity', undefined]) {
    const { input, responses } = fixture(); responses.get(workflow).state = state;
    assert.throws(() => verifyHistoryDeploymentFreeze(input), /Freeze/);
  }
  for (const state of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    const { input, responses } = fixture(); responses.get(`${workflow}/runs?status=${state}&per_page=1`).total_count++;
    assert.throws(() => verifyHistoryDeploymentFreeze(input), /Drain pending/);
  }
  for (const value of [{}, { total_count: 1, workflow_runs: [] },
    { total_count: 1, workflow_runs: [{ id: 99, status: 'queued' }] },
    { total_count: 1, workflow_runs: [{ id: 37241624452, status: 'in_progress' }] }]) {
    const { input, responses } = fixture(); responses.set(`${workflow}/runs?status=queued&per_page=1`, value);
    assert.throws(() => verifyHistoryDeploymentFreeze(input), /Drain pending/);
  }
});

test('a changed deployment freeze is rejected on a later bounded check', () => {
  const { input, responses } = fixture(); verifyHistoryDeploymentFreeze(input);
  responses.get(workflow).state = 'active';
  assert.throws(() => verifyHistoryDeploymentFreeze(input), /Freeze/);
});

test('CLI recovery flag is explicit, exact and only for cloud mutations', () => {
  const cloud = ['--manifest', 'history.json', '--deployment-manifest', 'api.json', '--worker-manifest', 'worker.json', '--profile', '3fc-agent'];
  assert.equal(historyArguments(['activate', ...cloud, '--apply', 'reviewed-history', '--exclude-stuck-run', '37241624452']).options['--exclude-stuck-run'], '37241624452');
  for (const args of [
    ['activate', ...cloud, '--apply', 'reviewed-history', '--exclude-stuck-run', 'any'],
    ['activate', '--manifest', 'local.json', '--local-table', '3fc-local', '--apply', 'reviewed-history', '--exclude-stuck-run', '37241624452'],
    ['status', ...cloud, '--league', 'league', '--exclude-stuck-run', '37241624452'],
    ['activate', ...cloud, '--exclude-stuck-run', '37241624452'],
  ]) assert.throws(() => historyArguments(args));
});
