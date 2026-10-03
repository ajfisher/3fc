import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { verifyHistoryManifest, historyFilters } from '../deploy/verify-player-history.mjs';

function fixture(enabled = 'false') {
  const env = 'qa', accountId = '301691475109', region = 'ap-southeast-2';
  const prefix = `arn:aws:sqs:${region}:${accountId}:3fc-qa-player-history`;
  const queueUrl = `https://sqs.${region}.amazonaws.com/${accountId}/3fc-qa-player-history`;
  const tableArn = `arn:aws:dynamodb:${region}:${accountId}:table/3fc-qa-app`;
  const manifest = { env, service: 'player-history', gitCommit: 'a'.repeat(40), region, accountId, tableName: '3fc-qa-app',
    streamArn: `${tableArn}/stream/2026-10-04T01:00:00.000`, queueUrl, queueArn: prefix,
    deadQueueArn: `${prefix}-dead`, dispatchDeadQueueArn: `${prefix}-dispatch-dead`, processingEnabled: enabled,
    roles: {}, packageHashes: { dispatch: 'dispatch-package', worker: 'work-package' },
    snapshot: { table: { TableArn: tableArn, TableStatus: 'ACTIVE', LatestStreamArn: `${tableArn}/stream/2026-10-04T01:00:00.000`,
      StreamSpecification: { StreamEnabled: true, StreamViewType: 'NEW_IMAGE' } },
      queue: { QueueArn: prefix, VisibilityTimeout: '360', MessageRetentionPeriod: '345600', SqsManagedSseEnabled: 'true',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: `${prefix}-dead`, maxReceiveCount: 5 }) },
      dead: { QueueArn: `${prefix}-dead`, MessageRetentionPeriod: '1209600', SqsManagedSseEnabled: 'true' },
      dispatchDead: { QueueArn: `${prefix}-dispatch-dead`, MessageRetentionPeriod: '1209600', SqsManagedSseEnabled: 'true' },
      functions: {}, concurrency: {}, mappings: {} } };
  for (const kind of ['dispatch', 'worker']) {
    const functionName = `3fc-qa-player-history-${kind}`, role = `arn:aws:iam::${accountId}:role/${functionName}`;
    manifest.roles[kind] = role;
    const functionArn = `arn:aws:lambda:${region}:${accountId}:function:${functionName}`;
    manifest.snapshot.functions[kind] = { functionName, functionArn, codeSha256: manifest.packageHashes[kind], revisionId: `${kind}-revision`,
      lastUpdateStatus: 'Successful', state: 'Active', role,
      handler: `api/src/lambda-player-history.${kind === 'dispatch' ? 'dispatchHandler' : 'workHandler'}`,
      runtime: 'nodejs20.x', architectures: ['arm64'], timeout: kind === 'dispatch' ? 30 : 60, memorySize: kind === 'dispatch' ? 256 : 512,
      tableName: manifest.tableName, queueUrl, processingEnabled: enabled };
    manifest.snapshot.concurrency[kind] = { ReservedConcurrentExecutions: 2 };
    manifest.snapshot.mappings[kind] = [{ UUID: `${kind}-mapping`, FunctionArn: functionArn, State: enabled === 'true' ? 'Enabled' : 'Disabled',
      EventSourceArn: kind === 'dispatch' ? manifest.streamArn : prefix, BatchSize: kind === 'dispatch' ? 100 : 1,
      MaximumBatchingWindowInSeconds: kind === 'dispatch' ? 1 : 0, FunctionResponseTypes: ['ReportBatchItemFailures'],
      ...(kind === 'dispatch' ? { StartingPosition: 'TRIM_HORIZON', ParallelizationFactor: 1, BisectBatchOnFunctionError: true,
        MaximumRetryAttempts: 3, MaximumRecordAgeInSeconds: 3600, DestinationConfig: { OnFailure: { Destination: manifest.dispatchDeadQueueArn } },
        FilterCriteria: { Filters: historyFilters.map(filter => ({ Pattern: JSON.stringify(filter) })) } }
        : { ScalingConfig: { MaximumConcurrency: 2 } }) }];
  }
  return manifest;
}

test('history deployment verifies both packages, explicit processing state and provisioned transport', () => {
  for (const enabled of ['false', 'true']) {
    const manifest = fixture(enabled);
    verifyHistoryManifest(manifest, structuredClone(manifest.snapshot), 'qa', manifest.gitCommit);
    assert.throws(() => verifyHistoryManifest(manifest, manifest.snapshot, 'prod', manifest.gitCommit));
    assert.throws(() => verifyHistoryManifest(manifest, manifest.snapshot, 'qa', 'b'.repeat(40)));
  }
});

test('missing or changed live function evidence cannot pass, including a second accepted package', () => {
  const manifest = fixture();
  for (const kind of ['dispatch', 'worker']) {
    for (const key of Object.keys(manifest.snapshot.functions[kind])) {
      for (const missing of [false, true]) {
        const live = structuredClone(manifest.snapshot);
        if (missing) delete live.functions[kind][key]; else live.functions[kind][key] = 'changed';
        assert.throws(() => verifyHistoryManifest(manifest, live, 'qa', manifest.gitCommit), `${kind}.${key}`);
      }
    }
  }
  const invalid = fixture(); invalid.processingEnabled = 'maybe';
  assert.throws(() => verifyHistoryManifest(invalid, invalid.snapshot, 'qa', invalid.gitCommit));
  const absent = fixture(); delete absent.packageHashes.worker;
  assert.throws(() => verifyHistoryManifest(absent, absent.snapshot, 'qa', absent.gitCommit));
  const wrongTable = fixture(); wrongTable.tableName = '3fc-prod-app';
  assert.throws(() => verifyHistoryManifest(wrongTable, wrongTable.snapshot, 'qa', wrongTable.gitCommit));
});

test('mapping drift, duplicate consumers, queue policy changes and missing evidence fail closed', () => {
  const manifest = fixture();
  const mutations = [
    live => { live.mappings.dispatch[0].State = 'Enabled'; },
    live => { live.mappings.worker[0].State = 'Enabling'; },
    live => { live.mappings.dispatch[0].UUID = 'replacement'; },
    live => { live.mappings.worker.push(structuredClone(live.mappings.worker[0])); },
    live => { live.mappings.dispatch[0].FilterCriteria.Filters.pop(); },
    live => { live.mappings.worker[0].FilterCriteria = { Filters: [{ Pattern: '{}' }] }; },
    live => { live.mappings.dispatch[0].DestinationConfig.OnFailure.Destination = manifest.deadQueueArn; },
    live => { live.mappings.worker[0].FunctionResponseTypes = []; },
    live => { live.mappings.dispatch[0].MaximumBatchingWindowInSeconds = 0; },
    live => { live.mappings.worker[0].ScalingConfig.MaximumConcurrency = 10; },
    live => { live.concurrency.worker.ReservedConcurrentExecutions = 10; },
    live => { live.queue.VisibilityTimeout = '60'; },
    live => { live.queue.RedrivePolicy = JSON.stringify({ deadLetterTargetArn: manifest.deadQueueArn, maxReceiveCount: 100 }); },
    live => { live.dead.MessageRetentionPeriod = '60'; },
    live => { delete live.dispatchDead; },
    live => { live.table.StreamSpecification.StreamViewType = 'KEYS_ONLY'; },
    live => { live.table.LatestStreamArn = `${manifest.streamArn}changed`; },
  ];
  for (const mutate of mutations) {
    const live = structuredClone(manifest.snapshot); mutate(live);
    assert.throws(() => verifyHistoryManifest(manifest, live, 'qa', manifest.gitCommit));
  }
  for (const key of ['region', 'accountId', 'streamArn', 'queueUrl', 'queueArn', 'deadQueueArn', 'dispatchDeadQueueArn', 'roles']) {
    const invalid = fixture(); delete invalid[key];
    assert.throws(() => verifyHistoryManifest(invalid, invalid.snapshot, 'qa', invalid.gitCommit), key);
  }
});

test('history deployment stays in serialized jobs and requires separately provisioned infrastructure', () => {
  const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
  const service = read('serverless.player-history.yml');
  assert.match(service, /HISTORY_PROCESSING_ENABLED, 'false'/);
  assert.match(service, /MaximumConcurrency: 2/);
  assert.match(service, /BatchSize: 100\n        MaximumBatchingWindowInSeconds: 1/);
  assert.match(service, /BatchSize: 1\n        MaximumBatchingWindowInSeconds: 0/);
  assert.equal((service.match(/ReportBatchItemFailures/g) ?? []).length, 2);
  assert.doesNotMatch(service, /httpApi:/);
  const infrastructure = read('infra/application/player-history.tf');
  assert.doesNotMatch(infrastructure, /dynamodb:Scan|ses:|s3:/);
  assert.match(infrastructure, /visibility_timeout_seconds = 360/);
  assert.match(infrastructure, /maxReceiveCount\s+= 5/);
  assert.match(infrastructure, /redrivePermission = "byQueue"/);
  const deploy = read('scripts/deploy/deploy-app.sh');
  assert(deploy.indexOf('if [[ "$SERVICE" == "player-history" ]]') < deploy.indexOf('HTTP_API_ID="${HTTP_API_ID:-}"'));
  assert.match(deploy, /EXPECTED_AWS_ACCOUNT_ID:-301691475109/);
  assert.match(deploy, /verify-player-history\.mjs.*--capture/);
  for (const environment of ['qa', 'prod']) {
    const workflow = read(`.github/workflows/deploy-${environment}.yml`);
    assert(workflow.indexOf(`SERVICE=player-history`) > workflow.indexOf(`SERVICE=api-core`));
    assert(workflow.indexOf(`verify-player-history.mjs ${environment}`) > workflow.indexOf(`verify-api-core.sh ${environment}`));
    assert.match(workflow, /HISTORY_PROCESSING_ENABLED: \$\{\{ vars.HISTORY_PROCESSING_ENABLED \|\| 'false' \}\}/);
    assert.match(workflow, new RegExp(`out/deploy/${environment}/player-history-deploy-manifest.json`));
    assert.doesNotMatch(workflow, /terraform apply|cancel-in-progress: true/);
  }
});
