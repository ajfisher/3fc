#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { verifyMigrationProvenance } from './player-identity-migrate.mjs';

export function homeCoverageArguments(args) {
  const command = args[0], options = {};
  if (!['status', 'begin', 'step', 'disable'].includes(command)) throw new Error('Choose status, begin, step or disable.');
  for (let i = 1; i < args.length; i += 2) {
    const key = args[i];
    if (!['--manifest', '--deployment-manifest', '--profile', '--apply', '--pages'].includes(key) || Object.hasOwn(options, key) || !args[i + 1])
      throw new Error('Unknown, duplicate or incomplete coverage option.');
    options[key] = args[i + 1];
  }
  for (const key of ['--manifest', '--deployment-manifest', '--profile']) if (!options[key]) throw new Error(`${key} is required.`);
  if (!/^[a-zA-Z0-9_.-]+$/.test(options['--profile'])) throw new Error('Choose an explicit AWS profile.');
  if (command !== 'status' && options['--apply'] !== 'reviewed-home-lookups') throw new Error('Mutations require --apply reviewed-home-lookups.');
  const pages = options['--pages'] === undefined ? 1 : Number(options['--pages']);
  if (!Number.isInteger(pages) || pages < 1 || pages > 100 || (options['--pages'] !== undefined && command !== 'step'))
    throw new Error('Only step accepts --pages from 1 to 100.');
  return { command, options, pages };
}

export function verifyHomeCoverageWorkflow(gh, env) {
  if (!['qa', 'prod'].includes(env)) throw new Error('Invalid deployment environment.');
  const workflow = `repos/ajfisher/3fc/actions/workflows/deploy-${env}.yml`;
  if (gh('api', workflow).state !== 'disabled_manually') throw new Error('Freeze the target deployment workflow for the reviewed reconciliation window.');
  for (const state of ['queued', 'in_progress', 'waiting', 'pending', 'requested']) {
    if (gh('api', `${workflow}/runs?status=${state}&per_page=1`).total_count !== 0) throw new Error('Drain pending target deployments before reconciliation.');
  }
}
export async function executeHomeCoverage(runner, verify, command, pages) {
  let value;
  for (let page = 0; page < pages; page++) {
    await verify(); // Every mutation, including the final ready page, is guarded.
    value = await runner[command]();
    if (command !== 'step' || !['backfill', 'verification'].includes(value.phase)) break;
  }
  return value;
}

async function main(args) {
  const { command, options, pages } = homeCoverageArguments(args);
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const manifest = JSON.parse(await readFile(options['--manifest'], 'utf8'));
  const deployment = JSON.parse(await readFile(options['--deployment-manifest'], 'utf8'));
  if (resolve(process.cwd()) !== root || execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== manifest.writerSha ||
    execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim() ||
    execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'api/src', 'packages/contracts/src', 'scripts'], { encoding: 'utf8' }).trim())
    throw new Error('Run from a clean repository root at the exact reviewed writer SHA.');
  // Run this CLI under the repository resource guard; it must encompass this build.
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--build', 'api/tsconfig.json', '--force'], { stdio: 'pipe', timeout: 120_000 });
  const { HomeLeagueCoverageRunner } = await import('../api/dist/data/home-league-coverage.js');
  process.env.AWS_PROFILE = options['--profile'];
  const client = new DynamoDBClient({ region: manifest.region });
  const aws = (...parameters) => JSON.parse(execFileSync('aws', [...parameters, '--profile', options['--profile'], '--region', manifest.region, '--output', 'json'],
    { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }));
  const gh = (...parameters) => JSON.parse(execFileSync('gh', parameters, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }));
  try {
    const caller = aws('sts', 'get-caller-identity');
    const { Table: table } = await client.send(new DescribeTableCommand({ TableName: manifest.tableName }));
    const verify = () => {
      const live = aws('lambda', 'get-function-configuration', '--function-name', deployment.functionFingerprint?.functionName ?? 'invalid', '--query',
        '{functionName:FunctionName,codeSha256:CodeSha256,revisionId:RevisionId,state:State,lastUpdateStatus:LastUpdateStatus,lastModified:LastModified,timeout:Timeout,tableName:Environment.Variables.DYNAMODB_TABLE,claimMode:Environment.Variables.PLAYER_CLAIM_MODE}');
      verifyMigrationProvenance({ manifest, deployment, caller, table: table ?? {}, live, now: Date.now() });
      if (command !== 'status') {
        verifyHomeCoverageWorkflow(gh, deployment.env);
      }
    };
    const runner = new HomeLeagueCoverageRunner(client, manifest);
    const value = await executeHomeCoverage(runner, verify, command, pages);
    process.stdout.write(`${JSON.stringify({ phase: value?.phase ?? 'not-started', pages: value?.pages ?? 0,
      repaired: value?.repaired ?? 0, verified: value?.verified ?? 0, morePages: Boolean(value?.cursor) })}\n`);
  } finally { client.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => { process.stderr.write('Home lookup operation failed; verify provenance and reconcile the current page before retrying.\n'); process.exitCode = 1; });
}
