#!/usr/bin/env node
// Capture and recheck only nonsecret deployment evidence. Never repair live drift.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const nonempty = value => typeof value === 'string' && value.length > 0;
export const historyFilters = [
  { eventName: ['INSERT'], dynamodb: { NewImage: { entityType: { S: ['playerHistoryWork'] } } } },
  { eventName: ['INSERT', 'MODIFY'], dynamodb: { NewImage: { entityType: { S: ['playerHistoryJob'] } } } },
  { eventName: ['INSERT', 'MODIFY'], dynamodb: {
    Keys: { pk: { S: [{ prefix: 'LEAGUE#' }] }, sk: { S: ['PLAYER_DIRECTORY'] } },
    NewImage: { entityType: { S: ['playerDirectoryRevision'] } }
  } },
  { eventName: ['INSERT', 'MODIFY'], dynamodb: {
    Keys: { pk: { S: [{ prefix: 'PLAYER_PROFILE_WORK#' }] } },
    NewImage: { entityType: { S: ['playerProfileNameWork', 'playerProfileMediaWork', 'playerProfileMediaRetirement'] } }
  } },
];

export function verifyHistorySnapshot(intent, snapshot) {
  assert(['qa', 'prod'].includes(intent.env), 'Unknown deployment environment');
  assert(/^[a-f0-9]{40}$/.test(intent.gitCommit), 'Missing full deployment commit');
  assert.equal(intent.service, 'player-history');
  assert(['true', 'false'].includes(intent.processingEnabled), 'Invalid processing switch');
  assert(/^\d{12}$/.test(intent.accountId), 'Invalid AWS account');
  assert(nonempty(intent.region) && nonempty(intent.tableName), 'Missing deployment scope');
  assert.equal(intent.portraitBucket, `3fc-${intent.env}-portraits-${intent.accountId}`);
  assert.equal(intent.tableName, `3fc-${intent.env}-app`, 'History must use this environment\'s application table');
  const prefix = `arn:aws:sqs:${intent.region}:${intent.accountId}:3fc-${intent.env}-player-history`;
  assert.equal(intent.queueArn, prefix);
  assert.equal(intent.deadQueueArn, `${prefix}-dead`);
  assert.equal(intent.dispatchDeadQueueArn, `${prefix}-dispatch-dead`);
  assert.equal(intent.queueUrl, `https://sqs.${intent.region}.amazonaws.com/${intent.accountId}/3fc-${intent.env}-player-history`);
  const tableArn = `arn:aws:dynamodb:${intent.region}:${intent.accountId}:table/${intent.tableName}`;
  assert(nonempty(intent.streamArn) && intent.streamArn.startsWith(`${tableArn}/stream/`), 'Unexpected source stream');
  assert.equal(snapshot.table.TableArn, tableArn);
  assert.equal(snapshot.table.TableStatus, 'ACTIVE');
  assert.equal(snapshot.table.LatestStreamArn, intent.streamArn);
  assert.deepEqual(snapshot.table.StreamSpecification, { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' });
  assert.equal(snapshot.queue.QueueArn, intent.queueArn);
  assert.equal(snapshot.queue.VisibilityTimeout, '360');
  assert.equal(snapshot.queue.MessageRetentionPeriod, '345600');
  assert.equal(snapshot.queue.SqsManagedSseEnabled, 'true');
  const redrive = JSON.parse(snapshot.queue.RedrivePolicy);
  assert.equal(redrive.deadLetterTargetArn, intent.deadQueueArn);
  assert.equal(Number(redrive.maxReceiveCount), 5);
  for (const [key, expectedArn] of [['dead', intent.deadQueueArn], ['dispatchDead', intent.dispatchDeadQueueArn]]) {
    assert.equal(snapshot[key].QueueArn, expectedArn);
    assert.equal(snapshot[key].MessageRetentionPeriod, '1209600');
    assert.equal(snapshot[key].SqsManagedSseEnabled, 'true');
  }
  for (const kind of ['dispatch', 'worker']) {
    const f = snapshot.functions[kind], expectedName = `3fc-${intent.env}-player-history-${kind}`;
    assert.equal(f.functionName, expectedName);
    assert.equal(f.functionArn, `arn:aws:lambda:${intent.region}:${intent.accountId}:function:${expectedName}`);
    assert.equal(f.lastUpdateStatus, 'Successful'); assert.equal(f.state, 'Active');
    assert(nonempty(f.revisionId) && nonempty(intent.packageHashes[kind]), 'Missing function/package fingerprint');
    assert.equal(f.codeSha256, intent.packageHashes[kind]);
    assert.equal(f.tableName, intent.tableName); assert.equal(f.queueUrl, intent.queueUrl);
    assert.equal(f.processingEnabled, intent.processingEnabled);
    assert.equal(f.portraitBucket, intent.portraitBucket);
    assert.equal(f.role, `arn:aws:iam::${intent.accountId}:role/3fc-${intent.env}-player-history-${kind}`);
    assert.equal(f.role, intent.roles[kind]);
    assert.equal(f.handler, `api/src/lambda-player-history.${kind === 'dispatch' ? 'dispatchHandler' : 'workHandler'}`);
    assert.equal(f.runtime, 'nodejs22.x'); assert.deepEqual(f.architectures, ['arm64']);
    assert.equal(f.timeout, kind === 'dispatch' ? 30 : 60);
    assert.equal(f.memorySize, kind === 'dispatch' ? 256 : 512);
    assert.deepEqual(snapshot.concurrency[kind], {}, 'History functions must use shared unreserved capacity');
    const mappings = snapshot.mappings[kind];
    assert(Array.isArray(mappings) && mappings.length === 1, 'Expected exactly one mapping per function');
    const mapping = mappings[0]; assert(nonempty(mapping.UUID), 'Missing mapping identity');
    assert.equal(mapping.FunctionArn, f.functionArn);
    assert.equal(mapping.State, intent.processingEnabled === 'true' ? 'Enabled' : 'Disabled');
    assert.deepEqual(mapping.FunctionResponseTypes, ['ReportBatchItemFailures']);
    assert.equal(mapping.MaximumBatchingWindowInSeconds, kind === 'dispatch' ? 1 : 0);
    assert.equal(mapping.BatchSize, kind === 'dispatch' ? 100 : 1);
    assert.equal(mapping.EventSourceArn, kind === 'dispatch' ? intent.streamArn : intent.queueArn);
    if (kind === 'dispatch') {
      assert.equal(mapping.StartingPosition, 'TRIM_HORIZON');
      assert.equal(mapping.ParallelizationFactor, 1);
      assert.equal(mapping.BisectBatchOnFunctionError, true);
      assert.equal(mapping.MaximumRetryAttempts, 3);
      assert.equal(mapping.MaximumRecordAgeInSeconds, 3600);
      assert.equal(mapping.DestinationConfig?.OnFailure?.Destination, intent.dispatchDeadQueueArn);
      assert.deepEqual(mapping.FilterCriteria?.Filters?.map(filter => JSON.parse(filter.Pattern)), historyFilters);
    } else {
      assert.equal(mapping.ScalingConfig?.MaximumConcurrency, 2);
      assert(!mapping.FilterCriteria?.Filters?.length, 'Worker queue messages must not be filtered away');
    }
  }
}

export function verifyHistoryManifest(manifest, snapshot, environment, head) {
  assert.equal(manifest.env, environment); assert.equal(manifest.gitCommit, head);
  verifyHistorySnapshot(manifest, manifest.snapshot);
  verifyHistorySnapshot(manifest, snapshot);
  assert.deepEqual(snapshot, manifest.snapshot, 'Worker deployment changed after acceptance');
}

export function parseHistoryAwsResponse(args, stdout) {
  // The CLI emits no JSON for a successful, unreserved function concurrency read.
  // Every other read still requires valid JSON; execution failures never get here.
  if (args[0] === 'lambda' && args[1] === 'get-function-concurrency' && stdout.trim() === '') return {};
  return JSON.parse(stdout);
}

function aws(region, ...args) {
  // An operator-selected profile must also win over ambient static credentials.
  const profile = process.env.AWS_PROFILE;
  const stdout = execFileSync('aws', [...args, ...(profile ? ['--profile', profile] : []),
    '--region', region, '--output', 'json'], { encoding: 'utf8', timeout: 30000 });
  return parseHistoryAwsResponse(args, stdout);
}

export function readHistorySnapshot(intent) {
  const read = (...args) => aws(intent.region, ...args);
  const queue = url => read('sqs', 'get-queue-attributes', '--queue-url', url, '--attribute-names',
    'QueueArn', 'VisibilityTimeout', 'MessageRetentionPeriod', 'RedrivePolicy', 'SqsManagedSseEnabled', '--query', 'Attributes');
  const result = { table: read('dynamodb', 'describe-table', '--table-name', intent.tableName,
    '--query', 'Table.{TableArn:TableArn,TableStatus:TableStatus,LatestStreamArn:LatestStreamArn,StreamSpecification:StreamSpecification}'),
    queue: queue(intent.queueUrl), dead: queue(`${intent.queueUrl}-dead`), dispatchDead: queue(`${intent.queueUrl}-dispatch-dead`),
    functions: {}, concurrency: {}, mappings: {} };
  for (const kind of ['dispatch', 'worker']) {
    const name = `3fc-${intent.env}-player-history-${kind}`;
    result.functions[kind] = read('lambda', 'get-function-configuration', '--function-name', name, '--query',
      '{functionName:FunctionName,functionArn:FunctionArn,codeSha256:CodeSha256,revisionId:RevisionId,lastUpdateStatus:LastUpdateStatus,state:State,role:Role,handler:Handler,runtime:Runtime,architectures:Architectures,timeout:Timeout,memorySize:MemorySize,tableName:Environment.Variables.DYNAMODB_TABLE,queueUrl:Environment.Variables.HISTORY_QUEUE_URL,processingEnabled:Environment.Variables.HISTORY_PROCESSING_ENABLED,portraitBucket:Environment.Variables.PORTRAIT_BUCKET}');
    result.concurrency[kind] = read('lambda', 'get-function-concurrency', '--function-name', name);
    result.mappings[kind] = read('lambda', 'list-event-source-mappings', '--function-name', name, '--query',
      'EventSourceMappings[].{UUID:UUID,FunctionArn:FunctionArn,State:State,EventSourceArn:EventSourceArn,BatchSize:BatchSize,MaximumBatchingWindowInSeconds:MaximumBatchingWindowInSeconds,FunctionResponseTypes:FunctionResponseTypes,StartingPosition:StartingPosition,ParallelizationFactor:ParallelizationFactor,BisectBatchOnFunctionError:BisectBatchOnFunctionError,MaximumRetryAttempts:MaximumRetryAttempts,MaximumRecordAgeInSeconds:MaximumRecordAgeInSeconds,DestinationConfig:DestinationConfig,FilterCriteria:FilterCriteria,ScalingConfig:ScalingConfig}');
  }
  return result;
}

function main() {
  const [environment, head, mode] = process.argv.slice(2);
  assert(['qa', 'prod'].includes(environment) && /^[a-f0-9]{40}$/.test(head ?? ''), 'Usage: verify-player-history.mjs <qa|prod> <head> [--capture]');
  assert(mode === undefined || mode === '--capture', 'Unknown verification mode');
  const path = `out/deploy/${environment}/player-history-deploy-manifest.json`;
  if (mode === '--capture') {
    const required = key => { assert(nonempty(process.env[key]), `Missing ${key}`); return process.env[key]; };
    const intent = { env: environment, service: 'player-history', gitCommit: head, deployedAtUtc: new Date().toISOString(),
      region: required('AWS_REGION'), accountId: required('HISTORY_ACCOUNT_ID'), tableName: required('DYNAMODB_TABLE'),
      streamArn: required('HISTORY_STREAM_ARN'), queueArn: required('HISTORY_QUEUE_ARN'), queueUrl: required('HISTORY_QUEUE_URL'),
      deadQueueArn: required('HISTORY_DEAD_QUEUE_ARN'), dispatchDeadQueueArn: required('HISTORY_DISPATCH_DEAD_QUEUE_ARN'),
      portraitBucket: required('PORTRAIT_BUCKET'), processingEnabled: required('HISTORY_PROCESSING_ENABLED'), roles: { dispatch: required('HISTORY_DISPATCH_ROLE_ARN'), worker: required('HISTORY_WORKER_ROLE_ARN') },
      packageHashes: { dispatch: createHash('sha256').update(readFileSync('.serverless/dispatch.zip')).digest('base64'),
        worker: createHash('sha256').update(readFileSync('.serverless/work.zip')).digest('base64') } };
    const live = readHistorySnapshot(intent); verifyHistorySnapshot(intent, live);
    mkdirSync(`out/deploy/${environment}`, { recursive: true });
    writeFileSync(path, `${JSON.stringify({ ...intent, snapshot: live }, null, 2)}\n`);
  } else {
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(manifest.env, environment); assert.equal(manifest.gitCommit, head);
    verifyHistorySnapshot(manifest, manifest.snapshot); // Validate scope before issuing AWS reads.
    verifyHistoryManifest(manifest, readHistorySnapshot(manifest), environment, head);
  }
  process.stdout.write('[deploy] Player history functions, transport and mappings match the accepted deployment.\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (error) { console.error(`Player history deployment verification failed: ${error.message}`); process.exitCode = 1; }
}
