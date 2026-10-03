import assert from 'node:assert/strict';
import test from 'node:test';
import { createHistoryDispatcher, createHistoryWorker, historyQueueReferenceSchema, processHistorySteps,
  type HistoryQueueReference } from '../history-transport.js';
import { historyHash } from '../data/player-history-model.js';

const revision = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const work: HistoryQueueReference = { version: 1, kind: 'work', leagueId: 'league', key: `HISTORY_WORK#${revision}` };
const player: HistoryQueueReference = { version: 1, kind: 'player', leagueId: 'league', key: `HISTORY_JOB#${historyHash('player')}` };
function stream(kind: 'work' | 'player' = 'work', sequence = '123') {
  const data = kind === 'work'
    ? { version: 1, leagueId: 'league', revision, createdAt: '2026-10-03T00:00:00Z', reason: 'goal-changed', gameId: 'game' }
    : { version: 1, leagueId: 'league', playerId: 'player', status: 'pending', requestedRevision: revision,
      spec: { context: { displayName: 'Private name', members: ['legacy'] } }, updatedAt: '2026-10-03T00:00:00Z' };
  const keys = { pk: { S: 'LEAGUE#league' }, sk: { S: kind === 'work' ? work.key : player.key } };
  return { eventSource: 'aws:dynamodb', eventName: 'INSERT', eventID: 'not-the-sequence-number', dynamodb: {
    SequenceNumber: sequence, Keys: structuredClone(keys), NewImage: { ...keys,
      entityType: { S: kind === 'work' ? 'playerHistoryWork' : 'playerHistoryJob' }, data: { S: JSON.stringify(data) } }
  } };
}
function sqs(reference: unknown = work, messageId = 'message-1') {
  return { eventSource: 'aws:sqs', messageId, body: JSON.stringify(reference) };
}
function replaceData(record: ReturnType<typeof stream>, fields: Record<string, unknown>) {
  record.dynamodb.NewImage.data.S = JSON.stringify({ ...JSON.parse(record.dynamodb.NewImage.data.S), ...fields });
  return record;
}

test('stream dispatcher publishes only strict work/player references and omits stored checkpoint/private data', async () => {
  const sent: Array<{ reference: HistoryQueueReference; delay: number | undefined }> = [];
  const handler = createHistoryDispatcher({ enabled: () => true, send: async (reference, delay) => { sent.push({ reference, delay }); } });
  const modified = stream('player', '125'); modified.eventName = 'MODIFY';
  assert.deepEqual(await handler({ Records: [stream(), stream('player', '124'), modified] }), { batchItemFailures: [] });
  assert.deepEqual(sent, [{ reference: work, delay: 0 }, { reference: player, delay: 0 }, { reference: player, delay: 0 }]);
  assert.equal(JSON.stringify(sent).includes('Private name'), false);
});

test('dispatcher ignores work modifications, finished/failed jobs, removals and unrelated records', async () => {
  const modified = stream(); modified.eventName = 'MODIFY';
  const removed = stream(); removed.eventName = 'REMOVE';
  const unrelated = stream(); unrelated.dynamodb.Keys.sk.S = 'HISTORY_SOURCE';
  unrelated.dynamodb.NewImage.sk.S = 'HISTORY_SOURCE'; unrelated.dynamodb.NewImage.entityType.S = 'playerHistorySource';
  const handler = createHistoryDispatcher({ enabled: () => true, send: async () => { assert.fail('ignored image must not be sent'); } });
  assert.deepEqual(await handler({ Records: [modified, removed, unrelated,
    replaceData(stream('player'), { status: 'done' }), replaceData(stream('player'), { status: 'failed' })] }), { batchItemFailures: [] });
});

test('forged stream scope, key, entity, source or data fails with stream sequence number', async () => {
  const malformed = [
    replaceData(stream(), { leagueId: 'another-league' }),
    replaceData(stream('player'), { playerId: 'another-player' }),
    replaceData(stream(), { revision: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    replaceData(stream(), { email: 'private@example.test' }),
    replaceData(stream('player'), { version: 2 }),
    replaceData(stream('player'), { status: 'invented' })
  ];
  const wrongKey = stream(); wrongKey.dynamodb.Keys.pk.S = 'LEAGUE#forged'; malformed.push(wrongKey);
  const wrongType = stream(); wrongType.dynamodb.NewImage.entityType.S = 'unrelated'; malformed.push(wrongType);
  const wrongSource = stream(); wrongSource.eventSource = 'aws:sqs'; malformed.push(wrongSource);
  const brokenJson = stream(); brokenJson.dynamodb.NewImage.data.S = '{'; malformed.push(brokenJson);
  const handler = createHistoryDispatcher({ enabled: () => true, send: async () => { assert.fail('forged record sent'); } });
  for (const record of malformed) assert.deepEqual(await handler({ Records: [record] }), { batchItemFailures: [{ itemIdentifier: '123' }] });
});

test('dispatcher retries only failed queue sends using SequenceNumber rather than eventID', async () => {
  const handler = createHistoryDispatcher({ enabled: () => true, send: async reference => {
    if (reference.kind === 'work') throw new Error('send failed');
  } });
  assert.deepEqual(await handler({ Records: [stream('work', '100'), stream('player', '200')] }),
    { batchItemFailures: [{ itemIdentifier: '100' }] });
});

test('worker re-reads validated references, continues unfinished checkpoints and acknowledges completed work', async () => {
  const processed: HistoryQueueReference[] = [], sent: Array<[HistoryQueueReference, number | undefined]> = [];
  const handler = createHistoryWorker({ enabled: () => true, process: async reference => {
    processed.push(reference); return { done: reference.kind === 'player' };
  }, send: async (reference, delay) => { sent.push([reference, delay]); } });
  assert.deepEqual(await handler({ Records: [sqs(work), sqs(player, 'message-2')] }), { batchItemFailures: [] });
  assert.deepEqual(processed, [work, player]); assert.deepEqual(sent, [[work, 1]]);
});

test('failed continuation sends and coordinator errors retry the original SQS message without affecting successes', async () => {
  const handler = createHistoryWorker({ enabled: () => true,
    process: async reference => { if (reference.kind === 'player') throw new Error('checkpoint failed'); return { done: false }; },
    send: async () => { throw new Error('queue unavailable'); } });
  assert.deepEqual(await handler({ Records: [sqs(work, 'original-work'), sqs(player, 'original-player')] }),
    { batchItemFailures: [{ itemIdentifier: 'original-work' }, { itemIdentifier: 'original-player' }] });
  const partial = createHistoryWorker({ enabled: () => true,
    process: async reference => { if (reference.kind === 'work') throw new Error('unavailable'); return { done: true }; },
    send: async () => { assert.fail('completed record must not continue'); } });
  assert.deepEqual(await partial({ Records: [sqs(work, 'bad'), sqs(player, 'good')] }), { batchItemFailures: [{ itemIdentifier: 'bad' }] });
});

test('malformed or extended queue references cannot reach the coordinator', async () => {
  const references = [null, {}, { ...work, version: 2 }, { ...work, kind: 'unknown' }, { ...work, leagueId: '' },
    { ...work, leagueId: ' ' }, { ...work, leagueId: 'x'.repeat(2048) }, { ...work, key: player.key },
    { ...player, key: work.key }, { ...player, key: 'HISTORY_JOB#abc' }, { ...work, key: 'HISTORY_SOURCE' },
    { ...work, playerId: 'injected' }, { ...work, spec: { privateEmail: 'private@example.test' } }];
  const handler = createHistoryWorker({ enabled: () => true,
    process: async () => { assert.fail('invalid reference reached coordinator'); }, send: async () => { assert.fail('invalid reference sent'); } });
  for (const reference of references) {
    assert.equal(historyQueueReferenceSchema.safeParse(reference).success, false);
    assert.deepEqual(await handler({ Records: [sqs(reference)] }), { batchItemFailures: [{ itemIdentifier: 'message-1' }] });
  }
  for (const record of [{ ...sqs(), body: '{' }, { ...sqs(), body: ' '.repeat(8193) }, { ...sqs(), eventSource: 'aws:dynamodb' }])
    assert.deepEqual(await handler({ Records: [record] }), { batchItemFailures: [{ itemIdentifier: 'message-1' }] });
});

test('disabled handlers preserve every message for retry and never send or advance checkpoints', async () => {
  const dependencies = { enabled: () => false, send: async () => { assert.fail('disabled send'); },
    process: async () => { assert.fail('disabled process'); } };
  assert.deepEqual(await createHistoryDispatcher(dependencies)({ Records: [stream('work', '123'), stream('player', '456')] }),
    { batchItemFailures: [{ itemIdentifier: '123' }, { itemIdentifier: '456' }] });
  assert.deepEqual(await createHistoryWorker(dependencies)({ Records: [sqs(work, 'a'), sqs(player, 'b')] }),
    { batchItemFailures: [{ itemIdentifier: 'a' }, { itemIdentifier: 'b' }] });
});

test('unidentifiable records and excessive batches fail the whole invocation before side effects', async () => {
  const dependencies = { enabled: () => true, send: async () => { assert.fail('invalid batch sent'); },
    process: async () => { assert.fail('invalid batch processed'); } };
  const dispatch = createHistoryDispatcher(dependencies), worker = createHistoryWorker(dependencies);
  for (const event of [{}, { Records: null }, { Records: Array.from({ length: 101 }, () => stream()) },
    { Records: [stream(), { eventID: 'cannot-substitute-event-id', dynamodb: {} }] }]) await assert.rejects(dispatch(event));
  for (const event of [{}, { Records: null }, { Records: Array.from({ length: 11 }, () => sqs()) },
    { Records: [sqs(), { body: '{}' }] }]) await assert.rejects(worker(event));
});

test('invalid coordinator completion cannot silently acknowledge a message', async () => {
  const handler = createHistoryWorker({ enabled: () => true, process: async () => ({} as { done: boolean }),
    send: async () => { assert.fail('invalid completion cannot continue'); } });
  assert.deepEqual(await handler({ Records: [sqs()] }), { batchItemFailures: [{ itemIdentifier: 'message-1' }] });
});

test('bounded checkpoint processing advances at most eight sequential steps using the same reference', async () => {
  let steps = 0, active = 0;
  const result = await processHistorySteps(work, async reference => {
    assert.equal(reference, work); assert.equal(active, 0, 'checkpoint operations must never overlap');
    active++; steps++; await Promise.resolve(); active--;
    return { done: false };
  }, { now: () => 0 });
  assert.deepEqual(result, { done: false }); assert.equal(steps, 8); assert.equal(active, 0);
});

test('bounded checkpoint processing stops immediately on durable completion', async () => {
  let steps = 0;
  const result = await processHistorySteps(work, async () => ({ done: ++steps === 3 }), { now: () => 0 });
  assert.deepEqual(result, { done: true }); assert.equal(steps, 3);
});

test('checkpoint processing respects the five-second budget and waits for the in-flight step to settle', async () => {
  let now = 0, steps = 0;
  const result = await processHistorySteps(work, async () => {
    steps++; await Promise.resolve(); now += 1250; return { done: false };
  }, { now: () => now });
  assert.deepEqual(result, { done: false }); assert.equal(steps, 4); assert.equal(now, 5000);
  let settled = false;
  const completed = await processHistorySteps(work, async () => {
    now += 7000; await Promise.resolve(); settled = true; return { done: true };
  }, { now: () => now });
  assert.equal(settled, true); assert.deepEqual(completed, { done: true }, 'completed step remains authoritative even when it exceeds the budget');
});

test('checkpoint processing reserves fifteen seconds for continuation and batch completion', async () => {
  let remaining = 16000, steps = 0;
  assert.deepEqual(await processHistorySteps(work, async () => {
    steps++; remaining -= 1000; return { done: false };
  }, { now: () => 0, remaining: () => remaining }), { done: false });
  assert.equal(steps, 2, 'exactly 15000ms is permitted; below it no new checkpoint begins');
  assert.deepEqual(await processHistorySteps(work, async () => {
    assert.fail('insufficient invocation time must not advance a checkpoint');
  }, { now: () => 0, remaining: () => 14999 }), { done: false });
});

test('checkpoint failures and malformed completions stop the loop without speculative extra steps', async () => {
  const error = new Error('checkpoint unavailable'); let steps = 0;
  await assert.rejects(processHistorySteps(work, async () => {
    if (++steps === 3) throw error;
    return { done: false };
  }, { now: () => 0 }), value => value === error);
  assert.equal(steps, 3);
  let invalidCalls = 0;
  await assert.rejects(processHistorySteps(work, async () => {
    invalidCalls++; return {} as { done: boolean };
  }, { now: () => 0 }), /invalid_processing_result/);
  assert.equal(invalidCalls, 1);
});

test('a batch of bounded checkpoints still emits one continuation and retries its original message on send failure', async () => {
  let steps = 0, sends = 0;
  const handler = createHistoryWorker({ enabled: () => true,
    process: reference => processHistorySteps(reference, async () => { steps++; return { done: false }; }, { now: () => 0 }),
    send: async (reference, delay) => {
      assert.deepEqual(reference, work); assert.equal(delay, 1); sends++; throw new Error('queue unavailable');
    } });
  assert.deepEqual(await handler({ Records: [sqs(work, 'original-message')] }), { batchItemFailures: [{ itemIdentifier: 'original-message' }] });
  assert.equal(steps, 8); assert.equal(sends, 1);
});
