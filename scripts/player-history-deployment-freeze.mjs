const states = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];

export function verifyHistoryDeploymentFreeze({ env, readGithub }) {
  if (!['qa', 'prod'].includes(env)) throw new Error('Unknown deployment environment.');
  const workflow = `repos/ajfisher/3fc/actions/workflows/deploy-${env}.yml`;
  const frozen = readGithub(workflow);
  if (frozen.state !== 'disabled_manually') throw new Error('Freeze the target deployment workflow during reviewed activation/backfill.');

  for (const state of states) {
    // Exact total count prevents an extra run being hidden by pagination.
    const runs = readGithub(`${workflow}/runs?status=${state}&per_page=1`);
    if (runs.total_count !== 0 || !Array.isArray(runs.workflow_runs) || runs.workflow_runs.length !== 0)
      throw new Error('Drain pending deployments before history operations.');
  }
}
