#!/usr/bin/env node
// Bounded operator/local runner for the exact service used by the SQS Lambda.
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import { verifyMigrationProvenance } from './player-identity-migrate.mjs';
import { verifyHistoryManifest, verifyHistorySnapshot, readHistorySnapshot } from './deploy/verify-player-history.mjs';

export function historyArguments(args) {
  const command = args[0], options = {};
  if (!['status', 'activate', 'backfill', 'step', 'recover', 'dry-run', 'profile-status', 'profile-step'].includes(command))
    throw new Error('Choose status, activate, backfill, step, recover, dry-run, profile-status or profile-step.');
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index];
    if (!['--manifest', '--deployment-manifest', '--worker-manifest', '--profile', '--local-table', '--league', '--player', '--key', '--kind', '--cursor', '--comparison', '--pages', '--apply'].includes(key)
      || Object.hasOwn(options, key) || !args[index + 1]) throw new Error('Unknown, duplicate or incomplete history option.');
    options[key] = args[index + 1];
  }
  if (!options['--manifest']) throw new Error('--manifest is required.');
  const local = Boolean(options['--local-table']);
  if (local ? options['--profile'] || options['--deployment-manifest'] || options['--worker-manifest'] : !options['--profile'] || !options['--deployment-manifest'] || !options['--worker-manifest'])
    throw new Error('Choose local-table or explicit cloud profile, API deployment manifest and worker manifest.');
  if (!local && !/^[a-zA-Z0-9_.-]+$/.test(options['--profile'])) throw new Error('Invalid AWS profile.');
  if (local && !/^[A-Za-z0-9_.-]{3,255}$/.test(options['--local-table'])) throw new Error('Invalid local table.');
  const profileWork = command === 'profile-status' || command === 'profile-step';
  if (profileWork ? !options['--player']?.trim() : command !== 'activate' && !options['--league']?.trim())
    throw new Error(profileWork ? '--player is required.' : '--league is required.');
  if (profileWork && (options['--league'] || options['--comparison'])) throw new Error('Profile work is player-scoped.');
  const pages = options['--pages'] === undefined ? 1 : Number(options['--pages']);
  if (!Number.isInteger(pages) || pages < 1 || pages > 100 || (options['--pages'] && !['step', 'dry-run', 'profile-step'].includes(command)))
    throw new Error('Only step/dry-run/profile-step accept --pages from 1 to 100.');
  if (!['status', 'profile-status'].includes(command) && options['--apply'] !== 'reviewed-history') throw new Error('Mutations require --apply reviewed-history.');
  if (['step', 'profile-step'].includes(command) && !options['--key']) throw new Error('--key is required.');
  if (command === 'profile-step' && !/^(?:NAME|MEDIA|RETIRE)#[0-9a-f-]{36}$/.test(options['--key'])) throw new Error('Choose an exact profile work key.');
  if (options['--kind'] && !(profileWork ? ['name', 'media', 'retirement'] : command === 'step' ? ['work', 'player', 'directory'] : ['work', 'player']).includes(options['--kind']))
    throw new Error('Choose work or player; step also accepts directory.');
  if (command === 'dry-run' && !options['--comparison'] && !options['--player']) throw new Error('Dry-run needs --player or --comparison.');
  return { command, options, pages, local };
}

export function verifyHistoryProvenance(input) {
  const manifest = { ...input.manifest, tableArn: `arn:aws:dynamodb:${input.manifest.region}:${input.manifest.accountId}:table/${input.manifest.tableName}` };
  if (manifest.version !== 1 || manifest.writerVersion !== 1 || manifest.ruleVersion !== 1) throw new Error('Unsupported history writer/rule version.');
  return verifyMigrationProvenance({ ...input, manifest });
}

async function main(args) {
  const { command, options, pages, local } = historyArguments(args);
  const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
  if (resolve(process.cwd()) !== root) throw new Error('Run from the repository root.');
  const manifest = JSON.parse(await readFile(options['--manifest'], 'utf8'));
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (!local && (sha !== manifest.writerSha || execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim()
    || execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'api/src', 'packages/contracts/src', 'scripts'], { encoding: 'utf8' }).trim()))
    throw new Error('Cloud runs require a clean tracked checkout at the exact writer SHA.');
  // The outer owned resource guard must encompass this fresh build and runner.
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--build', 'api/tsconfig.json', '--force'], { stdio: 'pipe', timeout: 120_000 });
  const { activateHistory, historyActivationManifestSchema } = await import('../api/dist/data/player-history-readiness.js');
  const { HistoryCoordinator } = await import('../api/dist/data/player-history-coordinator.js');
  const { ProfileNameWorker } = await import('../api/dist/data/player-profile-name-worker.js');
  const { PlayerPortraitWorker } = await import('../api/dist/data/player-portrait-worker.js');
  const { createPortraitStore } = await import('../api/dist/media/portrait-store.js');
  const { profileWorkReferenceSchema, profilePlayerHash } = await import('../api/dist/data/player-profile-work.js');
  historyActivationManifestSchema.parse(manifest);
  if (local && manifest.tableName !== options['--local-table']) throw new Error('Local table and manifest differ.');
  if (!local) process.env.AWS_PROFILE = options['--profile'];
  const client = new DynamoDBClient(local ? { region: manifest.region, endpoint: 'http://127.0.0.1:8000', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } }
    : { region: manifest.region });
  const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
  try {
    let verify = () => {};
    let verifyFinal = () => {};
    if (!local) {
      const deployment = JSON.parse(await readFile(options['--deployment-manifest'], 'utf8'));
      const aws = (...parameters) => JSON.parse(execFileSync('aws', [...parameters, '--profile', options['--profile'], '--region', manifest.region, '--output', 'json'],
        { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }));
      const caller = aws('sts', 'get-caller-identity');
      const { Table: table } = await client.send(new DescribeTableCommand({ TableName: manifest.tableName }));
      const readLive = () => aws('lambda', 'get-function-configuration', '--function-name', deployment.functionFingerprint?.functionName ?? 'invalid', '--query',
        '{functionName:FunctionName,codeSha256:CodeSha256,revisionId:RevisionId,state:State,lastUpdateStatus:LastUpdateStatus,lastModified:LastModified,timeout:Timeout,tableName:Environment.Variables.DYNAMODB_TABLE,claimMode:Environment.Variables.PLAYER_CLAIM_MODE}');
      const workers = JSON.parse(await readFile(options['--worker-manifest'], 'utf8'));
      if (workers.gitCommit !== manifest.writerSha || workers.accountId !== manifest.accountId || workers.tableName !== manifest.tableName || workers.region !== manifest.region)
        throw new Error('History worker manifest differs from the reviewed deployment scope.');
      verifyHistorySnapshot(workers, workers.snapshot);
      const verifyCore = () => verifyHistoryProvenance({ manifest, deployment, caller, table: table ?? {}, live: readLive(), now: Date.now() });
      verifyFinal = () => { verifyCore(); verifyHistoryManifest(workers, readHistorySnapshot(workers), deployment.env, manifest.writerSha); };
      verifyFinal();
      let lastVerified = Date.now();
      verify = () => { if (Date.now() - lastVerified >= 30_000) { verifyCore(); lastVerified = Date.now(); } };
      if (!['status', 'profile-status'].includes(command)) {
        const gh = (...parameters) => JSON.parse(execFileSync('gh', parameters, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }));
        const workflow = `repos/ajfisher/3fc/actions/workflows/deploy-${deployment.env}.yml`;
        if (gh('api', workflow).state !== 'disabled_manually') throw new Error('Freeze the target deployment workflow during reviewed activation/backfill.');
        for (const state of ['queued', 'in_progress', 'waiting', 'pending', 'requested'])
          if (gh('api', `${workflow}/runs?status=${state}&per_page=1`).total_count !== 0) throw new Error('Drain pending deployments before history operations.');
      }
    }
    const runner = new HistoryCoordinator(client, manifest.tableName), league = options['--league'];
    if (command === 'profile-status') {
      const kind = options['--kind'] ?? 'name';
      const worker = kind === 'name' ? new ProfileNameWorker(client, manifest.tableName)
        : new PlayerPortraitWorker(client, manifest.tableName, { delete: async () => { throw new Error('Read-only status cannot delete media.'); } });
      emit(kind === 'name' ? await worker.pendingPage(options['--player'], options['--cursor'] ?? null)
        : await worker.pendingPage(options['--player'], kind, options['--cursor'] ?? null));
    } else if (command === 'profile-step') {
      const isName = options['--key'].startsWith('NAME#');
      if (!local && !isName) process.env.PORTRAIT_BUCKET = JSON.parse(await readFile(options['--worker-manifest'], 'utf8')).portraitBucket;
      const worker = isName ? new ProfileNameWorker(client, manifest.tableName) : new PlayerPortraitWorker(client, manifest.tableName, createPortraitStore());
      const ref = profileWorkReferenceSchema.parse({ version: 1, kind: 'profile', playerHash: profilePlayerHash(options['--player']), key: options['--key'] });
      for (let step = 1; step <= pages; step++) { verify(); const result = await worker.process(ref); emit({ step, ...result }); if (result.done || result.delaySeconds) break; }
    } else if (command === 'status') {
      const sweep = await runner.status(league), pending = await runner.pendingPage(league, options['--kind'] ?? 'work', options['--cursor'] ?? null);
      emit({ sweep, pending });
    } else if (command === 'activate') {
      verify(); const ready = await activateHistory(client, manifest.tableName, manifest); emit({ enabled: true, revision: ready.revision, activatedAt: ready.activatedAt });
    } else if (command === 'backfill') {
      verify(); emit({ reference: await runner.requestRebuild(league) });
    } else if (command === 'recover') {
      verify();
      if (options['--player']) emit({ reference: await runner.recoverPlayer(league, options['--player']) });
      else emit(await runner.pendingPage(league, options['--kind'] ?? 'work', options['--cursor'] ?? null));
    } else if (command === 'dry-run') {
      verify(); const comparisonId = options['--comparison'] ?? await runner.startComparison(league, options['--player']);
      for (let step = 1; step <= pages; step++) {
        verify(); const result = await runner.stepComparison(league, comparisonId);
        emit({ comparisonId, step, done: result.done, ...(result.done ? { comparison: {
          scope: result.result.comparisonScope, includes: result.result.comparisonIncludes, totalsChanged: result.result.totalsChanged, achievementsChanged: result.result.achievementsChanged,
          before: result.result.before?.totals ?? null, after: result.result.after.totals,
          progressBefore: result.result.before?.counts ?? null, progressAfter: result.result.after.counts,
          uncertainBefore: result.result.before?.uncertain ?? null, uncertainAfter: result.result.after.uncertain
        } } : {}) });
        if (result.done) break;
      }
    } else {
      const ref = { version: 1, kind: options['--kind'] ?? 'work', leagueId: league, key: options['--key'] };
      for (let step = 1; step <= pages; step++) { verify(); const result = await runner.process(ref); emit({ step, done: result.done }); if (result.done) break; }
    }
    verifyFinal(); // A drift failure means this invocation cannot be claimed accepted.
  } finally { client.destroy(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${error instanceof Error && !Object.hasOwn(error, 'stderr') ? error.message : 'History operator check failed.'}\n`); process.exitCode = 1;
});
