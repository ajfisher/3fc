import { createHash } from 'node:crypto';

// Incident-specific: this immutable workflow rejects a stale main before obtaining
// AWS credentials. Do not extend this exception to arbitrary queued runs.
export const stuckProductionRun = Object.freeze({
  id: 37241624452,
  sha: '1732e95b042d6b57ea28fec7b8b48cd98d184bde',
  workflowId: 237189056,
});
const sourceHashes = {
  '.github/workflows/deploy-prod.yml': 'ba903ba1256dae4a58bfa0e58840e64783f4a1332b3d5484d9c88e7548a85484',
  'scripts/deploy/verify-production-head.mjs': 'fd7c4ac61e847942957fe7e70510a569fc8a741f6f5648444e0505fb4f6938f5',
};
const states = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];

export function verifyHistoryDeploymentFreeze({ env, writerSha, excludedRun, readGithub, readGit }) {
  if (!['qa', 'prod'].includes(env)) throw new Error('Unknown deployment environment.');
  const repository = 'repos/ajfisher/3fc';
  const workflow = `${repository}/actions/workflows/deploy-${env}.yml`;
  const frozen = readGithub(workflow);
  if (frozen.state !== 'disabled_manually') throw new Error('Freeze the target deployment workflow during reviewed activation/backfill.');

  if (excludedRun !== undefined) {
    if (env !== 'prod' || excludedRun !== String(stuckProductionRun.id) || frozen.id !== stuckProductionRun.workflowId)
      throw new Error('Only the reviewed stuck production run can be excluded.');
    const main = readGit(['ls-remote', '--exit-code', 'https://github.com/ajfisher/3fc.git', 'refs/heads/main']).trim();
    if (!/^[a-f0-9]{40}$/.test(writerSha) || writerSha === stuckProductionRun.sha || main !== `${writerSha}\trefs/heads/main`)
      throw new Error('Stuck-run recovery requires a newer deployed writer at current production main.');
    for (const [path, hash] of Object.entries(sourceHashes)) {
      const source = readGit(['show', `${stuckProductionRun.sha}:${path}`]);
      if (createHash('sha256').update(source).digest('hex') !== hash)
        throw new Error('Stuck-run workflow does not match the reviewed pre-credential guard.');
    }
    const run = readGithub(`${repository}/actions/runs/${excludedRun}`);
    if (run.id !== stuckProductionRun.id || run.workflow_id !== stuckProductionRun.workflowId
      || run.path !== '.github/workflows/deploy-prod.yml' || run.event !== 'workflow_dispatch'
      || run.head_branch !== 'main' || run.head_sha !== stuckProductionRun.sha || run.run_attempt !== 1
      || run.status !== 'queued' || run.conclusion !== null
      || run.repository?.full_name !== 'ajfisher/3fc' || run.head_repository?.full_name !== 'ajfisher/3fc')
      throw new Error('Stuck deployment changed state or identity; stop and investigate.');
    const jobs = readGithub(`${repository}/actions/runs/${excludedRun}/attempts/1/jobs?per_page=1`);
    if (jobs.total_count !== 0 || !Array.isArray(jobs.jobs) || jobs.jobs.length !== 0)
      throw new Error('A deployment with jobs cannot be excluded.');
  }

  for (const state of states) {
    // Exact total count prevents an extra run being hidden by pagination.
    const runs = readGithub(`${workflow}/runs?status=${state}&per_page=1`);
    const excluded = excludedRun !== undefined && state === 'queued';
    if (runs.total_count !== (excluded ? 1 : 0) || !Array.isArray(runs.workflow_runs)
      || runs.workflow_runs.length !== (excluded ? 1 : 0)
      || (excluded && (runs.workflow_runs[0].id !== stuckProductionRun.id || runs.workflow_runs[0].status !== 'queued')))
      throw new Error('Drain pending deployments before history operations.');
  }
}
