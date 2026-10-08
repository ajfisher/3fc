import assert from 'node:assert/strict';
import test from 'node:test';
import { homeCoverageArguments, verifyHomeCoverageWorkflow, executeHomeCoverage } from '../home-league-coverage.mjs';

test('home coverage CLI pins explicit manifests/profile and mutates only with reviewed apply token, bounded pages per invocation', () => {
  const common = ['--manifest', 'coverage.json', '--deployment-manifest', 'deployment.json', '--profile', '3fc-agent'];
  assert.equal(homeCoverageArguments(['status', ...common]).command, 'status');
  assert.equal(homeCoverageArguments(['step', ...common, '--apply', 'reviewed-home-lookups', '--pages', '100']).pages, 100);
  for (const command of ['begin', 'step', 'disable', 'enable-reader', 'disable-reader']) {
    assert.throws(() => homeCoverageArguments([command, ...common]));
    assert.equal(homeCoverageArguments([command, ...common, '--apply', 'reviewed-home-lookups']).command, command);
  }
  for (const args of [[], ['status'], ['activate', ...common], ['step', ...common, '--apply', 'reviewed-write-pause'],
    ['status', ...common, '--profile', 'other'], ['status', ...common, '--pages', '100'], ['step', ...common, '--apply', 'reviewed-home-lookups', '--pages', '101'], ['status', ...common, '--unknown', 'yes']])
    assert.throws(() => homeCoverageArguments(args));
});


test('enabled workflows and every pending deployment state prevent invoking a coverage mutation', async () => {
  for (const failure of ['enabled', 'queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    let mutations = 0;
    const gh = (_command, path) => path.includes('/runs?') ? { total_count: path.includes(`status=${failure}&`) ? 1 : 0 }
      : { state: failure === 'enabled' ? 'active' : 'disabled_manually' };
    await assert.rejects(executeHomeCoverage({ step: async () => { mutations++; return { phase: 'ready' }; } },
      () => verifyHomeCoverageWorkflow(gh, 'qa'), 'step', 1));
    assert.equal(mutations, 0, failure);
  }
});

test('batched coverage checks provenance before every page and stops on readiness or changed deployment', async () => {
  const calls = [];
  const runner = { step: async () => { calls.push('step'); return { phase: calls.filter(x => x === 'step').length === 2 ? 'ready' : 'verification' }; } };
  assert.equal((await executeHomeCoverage(runner, () => calls.push('verify'), 'step', 100)).phase, 'ready');
  assert.deepEqual(calls, ['verify', 'step', 'verify', 'step']);
  let verified = 0, mutated = 0;
  await assert.rejects(executeHomeCoverage({ step: async () => { mutated++; return { phase: 'backfill' }; } },
    () => { if (++verified === 2) throw new Error('writer fingerprint changed'); }, 'step', 3), /fingerprint changed/);
  assert.equal(mutated, 1);
});
