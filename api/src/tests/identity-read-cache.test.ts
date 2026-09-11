import assert from "node:assert/strict";
import test from "node:test";
import { BatchGetItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";
import { IdentityReadCache } from "../data/identity-read-cache.js";

const key = (id: number) => ({ pk: `PLAYER#${id}`, sk: "IDENTITY" });
const physical = (id: number) => ({ pk: { S: key(id).pk }, sk: { S: key(id).sk } });
const get = (cache: IdentityReadCache, id: number) => cache.send(new GetItemCommand({ TableName: "fixture", Key: physical(id), ConsistentRead: true }));

test("request cache deduplicates keys, bounds batches/concurrency and caches processed absence", async () => {
  let calls = 0, active = 0, maximum = 0;
  const client = { async send(command: unknown) {
    assert(command instanceof BatchGetItemCommand); calls++;
    const request = command.input.RequestItems!.fixture!;
    assert.equal(request.ConsistentRead, true); assert(request.Keys!.length <= 100);
    active++; maximum = Math.max(maximum, active); await Promise.resolve(); active--;
    return { Responses: { fixture: request.Keys!.filter(item => item.pk!.S !== "PLAYER#2").reverse() } };
  } };
  const cache = new IdentityReadCache(client, "fixture");
  await cache.prefetch([...Array.from({ length: 450 }, (_, index) => key(index)), key(0)]);
  assert.equal(calls, 5); assert.equal(maximum, 4); assert.equal(active, 0);
  assert.deepEqual(await get(cache, 0), { Item: physical(0) });
  assert.deepEqual(await get(cache, 2), { Item: undefined });
  await cache.prefetch([key(0), key(2)]); assert.equal(calls, 5);
  await assert.rejects(get(cache, 999), /could not be checked/);
  await new IdentityReadCache(client, "fixture").prefetch([key(0)]);
  assert.equal(calls, 6, "new requests never reuse earlier snapshots");
});

test("unprocessed keys retry strongly and are never cached as absent", async () => {
  let calls = 0;
  const cache = new IdentityReadCache({ async send(command: unknown) {
    assert(command instanceof BatchGetItemCommand); calls++;
    const request = command.input.RequestItems!.fixture!; assert.equal(request.ConsistentRead, true);
    if (calls === 1) return { Responses: { fixture: [physical(0)] }, UnprocessedKeys: { fixture: { Keys: [physical(1)] } } };
    assert.deepEqual(request.Keys, [physical(1)]);
    return { Responses: { fixture: [physical(1)] } };
  } }, "fixture");
  await cache.prefetch([key(0), key(1)]);
  assert.equal(calls, 2); assert.deepEqual(await get(cache, 1), { Item: physical(1) });
  let rejectedCalls = 0;
  const stuck = new IdentityReadCache({ async send() {
    rejectedCalls++; return { UnprocessedKeys: { fixture: { Keys: [physical(1)] } } };
  } }, "fixture");
  await assert.rejects(stuck.prefetch([key(1)]), /could not be checked/);
  assert.equal(rejectedCalls, 3); await assert.rejects(get(stuck, 1), /could not be checked/);
});

for (const [name, output] of Object.entries({
  foreignTable: { Responses: { other: [] } },
  unexpected: { Responses: { fixture: [physical(9)] } },
  duplicate: { Responses: { fixture: [physical(0), physical(0)] } },
  contradictory: { Responses: { fixture: [physical(0)] }, UnprocessedKeys: { fixture: { Keys: [physical(0)] } } },
  duplicateRetry: { UnprocessedKeys: { fixture: { Keys: [physical(0), physical(0)] } } },
  foreignRetry: { UnprocessedKeys: { other: { Keys: [] } } },
  nullRows: { Responses: { fixture: null } },
  nullRow: { Responses: { fixture: [null] } },
  missingRetryKeys: { UnprocessedKeys: { fixture: {} } },
  nullRetryKeys: { UnprocessedKeys: { fixture: { Keys: null } } },
  nullRetryTable: { UnprocessedKeys: { fixture: null } },
  nullResponses: { Responses: null },
  arrayResponses: { Responses: [] },
  nullUnprocessed: { UnprocessedKeys: null },
  arrayUnprocessed: { UnprocessedKeys: [] },
})) test(`batch response ${name} fails closed`, async () => {
  const cache = new IdentityReadCache({ async send() { return output; } }, "fixture");
  await assert.rejects(cache.prefetch([key(0)]), /could not be checked/);
  await assert.rejects(get(cache, 0), /could not be checked/);
});

test("partial unprocessed exhaustion keeps unresolved keys unknown and preserves first processed snapshot", async () => {
  let calls = 0;
  const original = { ...physical(0), data: { S: "original" } };
  const cache = new IdentityReadCache({ async send() {
    calls++;
    return { Responses: { fixture: calls === 1 ? [original] : [] }, UnprocessedKeys: { fixture: { Keys: [physical(1)] } } };
  } }, "fixture");
  await assert.rejects(cache.prefetch([key(0), key(1)]), /could not be checked/);
  assert.equal(calls, 3); await assert.rejects(get(cache, 1), /could not be checked/);
  const result = await get(cache, 0) as { Item: typeof original };
  assert.equal(result.Item.data.S, "original");
  result.Item.data.S = "mutated caller clone";
  original.data.S = "mutated upstream object";
  await cache.prefetch([key(0)]); assert.equal(calls, 3, "later prefetch does not replace a prior snapshot");
  assert.equal((await get(cache, 0) as { Item: typeof original }).Item.data.S, "original");
});

test("batch rejection waits for already started siblings before returning failure", async () => {
  let release!: () => void, began!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { began = resolve; });
  let calls = 0, finished = false, settled = false;
  const failure = new Error("controlled batch failure");
  const cache = new IdentityReadCache({ async send(command: unknown) {
    assert(command instanceof BatchGetItemCommand);
    const current = ++calls;
    if (current === 1) throw failure;
    began(); await blocked; finished = true;
    return { Responses: { fixture: command.input.RequestItems!.fixture!.Keys! } };
  } }, "fixture");
  const outcome = cache.prefetch(Array.from({ length: 101 }, (_, index) => key(index))).then(
    () => { settled = true; return null; }, error => { settled = true; return error; },
  );
  try {
    await started; await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false); assert.equal(finished, false);
  } finally { release(); }
  assert.equal(await outcome, failure); assert.equal(finished, true); assert.equal(calls, 2);
});
