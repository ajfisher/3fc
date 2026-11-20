import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyHistoryDeploymentFreeze } from '../player-history-deployment-freeze.mjs';
import { historyArguments } from '../player-history.mjs';

const states = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];
function fixture(env = 'prod') {
  const workflow = `repos/ajfisher/3fc/actions/workflows/deploy-${env}.yml`;
  const responses = new Map([[workflow, { state: 'disabled_manually' }]]);
  for (const state of states)
    responses.set(`${workflow}/runs?status=${state}&per_page=1`, { total_count: 0, workflow_runs: [] });
  const calls = [];
  const input = { env, readGithub: path => {
    calls.push(path); assert(responses.has(path), path); return structuredClone(responses.get(path));
  } };
  return { input, responses, workflow, calls };
}

for (const env of ['qa', 'prod']) {
  test(`${env} freeze requires a manually disabled workflow and checks every pending state`, () => {
    const { input, calls, responses } = fixture(env);
    assert.doesNotThrow(() => verifyHistoryDeploymentFreeze(input));
    assert.deepEqual(calls, [...responses.keys()]);
  });

  test(`${env} rejects enabled or otherwise non-manually-disabled workflows`, () => {
    for (const state of ['active', 'disabled_inactivity', 'deleted', undefined]) {
      const { input, responses, workflow } = fixture(env); responses.get(workflow).state = state;
      assert.throws(() => verifyHistoryDeploymentFreeze(input), /Freeze/);
    }
  });

  test(`${env} rejects every pending state, inconsistent pages and malformed evidence`, () => {
    for (const state of states) {
      for (const value of [{}, { total_count: 0 }, { total_count: 0, workflow_runs: null },
        { total_count: '0', workflow_runs: [] }, { total_count: -1, workflow_runs: [] },
        { total_count: 1, workflow_runs: [] }, // A run hidden beyond this page must still block.
        { total_count: 0, workflow_runs: [{ id: 99, status: state }] },
        { total_count: 1, workflow_runs: [{ id: 37241624452, status: state }] }]) {
        const { input, responses, workflow } = fixture(env);
        responses.set(`${workflow}/runs?status=${state}&per_page=1`, value);
        assert.throws(() => verifyHistoryDeploymentFreeze(input), /Drain pending/);
      }
    }
  });

  test(`${env} fails closed when any GitHub lookup fails`, () => {
    const { responses } = fixture(env);
    for (const failedPath of responses.keys()) {
      const { input } = fixture(env), read = input.readGithub;
      input.readGithub = path => { if (path === failedPath) throw new Error('GitHub unavailable'); return read(path); };
      assert.throws(() => verifyHistoryDeploymentFreeze(input), /GitHub unavailable/);
    }
  });

  test(`${env} rejects workflow or pending-run drift on a later bounded check`, () => {
    const { input, responses, workflow } = fixture(env); verifyHistoryDeploymentFreeze(input);
    responses.get(workflow).state = 'active';
    assert.throws(() => verifyHistoryDeploymentFreeze(input), /Freeze/);
    responses.get(workflow).state = 'disabled_manually';
    for (const state of states) {
      const path = `${workflow}/runs?status=${state}&per_page=1`;
      responses.set(path, { total_count: 1, workflow_runs: [{ id: 99, status: state }] });
      assert.throws(() => verifyHistoryDeploymentFreeze(input), /Drain pending/);
      responses.set(path, { total_count: 0, workflow_runs: [] });
    }
  });
}

test('unknown deployment environments fail before any GitHub lookup', () => {
  for (const env of ['local', 'production', '', undefined])
    assert.throws(() => verifyHistoryDeploymentFreeze({ env, readGithub: () => assert.fail('unexpected lookup') }), /Unknown deployment/);
});

test('retired CLI exception is rejected for cloud and local commands, including the former incident ID', () => {
  const contexts = [
    ['--manifest', 'history.json', '--deployment-manifest', 'api.json', '--worker-manifest', 'worker.json', '--profile', '3fc-agent'],
    ['--manifest', 'local.json', '--local-table', '3fc-local'],
  ];
  for (const context of contexts) {
    for (const command of ['activate', 'backfill', 'step', 'recover', 'dry-run', 'status', 'profile-status', 'profile-step']) {
      for (const id of ['37241624452', 'any'])
        assert.throws(() => historyArguments([command, ...context, '--apply', 'reviewed-history', '--exclude-stuck-run', id]), /Unknown, duplicate or incomplete history option/);
    }
  }
});
