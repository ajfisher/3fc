import assert from "node:assert/strict";
import test from "node:test";
import { BatchGetItemCommand, GetItemCommand, QueryCommand, type AttributeValue, type QueryCommandOutput } from "@aws-sdk/client-dynamodb";
import { identityDirectorySk, identityItem, PlayerIdentityPlanner } from "../data/player-identity.js";

type Item = Record<string, AttributeValue>;
const now = "2026-09-12T00:00:00.000Z";
const ids = Array.from({ length: 512 }, (_, index) => `p${index}`).sort((a, b) => identityDirectorySk(a).localeCompare(identityDirectorySk(b)));
const id = (index: number) => ids[index]!;
const row = (index: number, nickname = "Other", active = true) => identityItem("LEAGUE#league", identityDirectorySk(id(index)),
  "leaguePlayer", { playerId: id(index), nickname, formerNames: [], active, seasonIds: [], hasMoreSeasons: false }, now);
function fixture(rows: Item[]) {
  let calls = 0, controlReads = 0, batchCalls = 0, batchKeys = 0, active = 0, maxActive = 0;
  const starts: Array<string | undefined> = [];
  const state: { query?: (command: QueryCommand) => QueryCommandOutput; changeControl?: boolean; members?: number;
    onBatch?: (count: number) => void; missingIdentity?: boolean; malformedIdentity?: boolean } = {};
  const planner = new PlayerIdentityPlanner({ async send(command: unknown) {
    if (command instanceof BatchGetItemCommand) {
      batchCalls++; const request = command.input.RequestItems!.fixture!;
      assert.equal(request.ConsistentRead, true); assert(request.Keys!.length <= 100); batchKeys += request.Keys!.length;
      active++; maxActive = Math.max(maxActive, active); await Promise.resolve(); active--;
      state.onBatch?.(batchCalls);
      return { Responses: { fixture: request.Keys!.flatMap(key => {
        if (key.sk?.S !== "IDENTITY" || state.missingIdentity) return [];
        const playerId = key.pk!.S!.slice("PLAYER#".length), rootId = playerId.split("~")[0]!;
        const members = [rootId, ...Array.from({ length: (state.members ?? 1) - 1 }, (_, index) => `${rootId}~${index}`)];
        return [identityItem(key.pk!.S!, "IDENTITY", "playerIdentity", { playerId,
          rootId: state.malformedIdentity ? "other" : rootId, members: playerId === rootId ? members : [],
          identityVersion: 0, writeVersion: "version", displayName: playerId, formerNames: [] }, now)];
      }) } };
    }
    if (command instanceof GetItemCommand) {
      assert(!command.input.Key?.pk?.S?.startsWith("PLAYER#"), "Identity and season lookups must be batched, not serial network gets");
      if (command.input.Key?.pk?.S === "PLAYER_IDENTITY") {
        controlReads++;
        return { Item: identityItem("PLAYER_IDENTITY", "CONTROL", "playerIdentityControl", {
          mode: "fenced", coverage: "verified", epoch: state.changeControl && controlReads > 1 ? "changed" : "epoch", writerVersion: 1,
        }, now) };
      }
      return {};
    }
    assert(command instanceof QueryCommand);
    assert.equal(command.input.TableName, "fixture");
    assert.equal(command.input.ConsistentRead, true);
    assert.equal(command.input.ExpressionAttributeValues?.[":pk"]?.S, "LEAGUE#league");
    calls++; starts.push(command.input.ExclusiveStartKey?.sk?.S);
    if (state.query) return state.query(command);
    const start = command.input.ExclusiveStartKey?.sk?.S;
    const remaining = rows.filter(item => !start || item.sk!.S! > start);
    const items = remaining.slice(0, command.input.Limit);
    return { Items: items, ...(remaining.length > items.length ? { LastEvaluatedKey: { pk: items.at(-1)!.pk!, sk: items.at(-1)!.sk! } } : {}) };
  } }, "fixture");
  return { planner, state, starts, calls: () => calls, batchCalls: () => batchCalls, batchKeys: () => batchKeys, maxActive: () => maxActive };
}

test("logical directory pages find later matches and continue from the exact processed key", async () => {
  const f = fixture(Array.from({ length: 35 }, (_, index) => row(index, index >= 27 ? "Xavier" : "Other")));
  const first = await f.planner.directoryPage({ leagueId: "league", query: "xavier", limit: 3 });
  assert.deepEqual(first.entries.map(entry => entry.playerId), [id(27), id(28), id(29)]);
  assert.equal(first.searchIncomplete, undefined); assert(first.cursor);
  assert.equal(JSON.parse(Buffer.from(first.cursor, "base64url").toString()).sk, identityDirectorySk(id(29)));
  const second = await f.planner.directoryPage({ leagueId: "league", query: "xavier", limit: 3, cursor: first.cursor });
  assert.deepEqual(second.entries.map(entry => entry.playerId), [id(30), id(31), id(32)]);
  const last = await f.planner.directoryPage({ leagueId: "league", query: "xavier", limit: 3, cursor: second.cursor! });
  assert.deepEqual(last.entries.map(entry => entry.playerId), [id(33), id(34)]);
  assert.equal(last.cursor, null); assert.equal(last.searchIncomplete, undefined);
});

test("physical budget returns honest incomplete search and permits the later match", async () => {
  const f = fixture(Array.from({ length: 251 }, (_, index) => row(index, index === 250 ? "Kesh" : "Other")));
  const first = await f.planner.directoryPage({ leagueId: "league", query: "kesh" });
  assert.deepEqual(first.entries, []); assert.equal(first.searchIncomplete, true); assert(first.cursor);
  assert.equal(f.calls(), 10);
  const next = await f.planner.directoryPage({ leagueId: "league", query: "kesh", cursor: first.cursor });
  assert.deepEqual(next.entries.map(entry => entry.playerId), [id(250)]);
  assert.equal(next.cursor, null); assert.equal(next.searchIncomplete, undefined);
});

test("empty physical pages continue and inactive matches never occupy logical result slots", async () => {
  const f = fixture([]); let page = 0;
  f.state.query = () => ++page === 1 ? { $metadata: {}, Items: [], LastEvaluatedKey: { pk: { S: "LEAGUE#league" }, sk: { S: identityDirectorySk(id(0)) } } }
    : { $metadata: {}, Items: [row(1, "Kesh", false), row(2, "Kesh")] };
  const result = await f.planner.directoryPage({ leagueId: "league", query: "kesh", limit: 1 });
  assert.deepEqual(result.entries.map(entry => entry.playerId), [id(2)]); assert.equal(result.cursor, null);
  assert.deepEqual(f.starts, [undefined, identityDirectorySk(id(0))]);
});

test("logical directory pagination rejects malformed, repeated and backward physical cursors", async () => {
  for (const kind of ["foreign", "oversized", "repeat", "backward"] as const) {
    const f = fixture([]); let page = 0;
    f.state.query = () => {
      page++;
      const sk = kind === "oversized" ? "PLAYER#" + "x".repeat(1024) : kind === "backward" && page > 1 ? "PLAYER#p001" : "PLAYER#p002";
      return { $metadata: {}, Items: [], LastEvaluatedKey: { pk: { S: kind === "foreign" ? "LEAGUE#other" : "LEAGUE#league" }, sk: { S: sk } } };
    };
    await assert.rejects(f.planner.directoryPage({ leagueId: "league" }));
    assert(f.calls() <= 2);
  }
});

test("logical directory results remain bound to query and current control snapshot", async () => {
  const f = fixture([row(0, "Kesh"), row(1, "Kesh")]);
  const result = await f.planner.directoryPage({ leagueId: "league", query: "kesh", limit: 1 }); assert(result.cursor);
  await assert.rejects(f.planner.directoryPage({ leagueId: "league", query: "xavier", cursor: result.cursor }), error =>
    (error as { code?: string }).code === "invalid_player_cursor");
  f.state.changeControl = true;
  await assert.rejects(f.planner.directoryPage({ leagueId: "league", query: "kesh", cursor: result.cursor }), error =>
    (error as { code?: string }).code === "player_search_changed");
});

test("250 negative-season candidates with20 members use bounded batches rather than10000 serial gets", async () => {
  const f = fixture(Array.from({ length: 251 }, (_, index) => row(index, "Kesh"))); f.state.members = 20;
  const result = await f.planner.directoryPage({ leagueId: "league", query: "kesh", seasonId: "winter" }, { now: () => 0, deadlineMs: 6000 });
  assert.deepEqual(result.entries, []); assert.equal(result.searchIncomplete, true); assert(result.cursor);
  assert.equal(f.calls(), 10); assert.equal(f.batchKeys(), 10000); assert(f.batchCalls() <= 110);
  assert.equal(f.maxActive(), 4);
  assert.equal(JSON.parse(Buffer.from(result.cursor, "base64url").toString()).sk, identityDirectorySk(id(249)));
});

test("expired partial prefetch returns a restart cursor without skipping the first candidate", async () => {
  const f = fixture([row(0, "Kesh"), row(1, "Kesh")]); let clock = 0;
  f.state.onBatch = () => { clock = 6000; };
  const first = await f.planner.directoryPage({ leagueId: "league", query: "kesh" }, { now: () => clock, deadlineMs: 6000 });
  assert.deepEqual(first.entries, []); assert.equal(first.searchIncomplete, true); assert(first.cursor);
  assert.equal(JSON.parse(Buffer.from(first.cursor, "base64url").toString()).sk, "PLAYER#");
  clock = 0; f.state.onBatch = undefined;
  const retry = await f.planner.directoryPage({ leagueId: "league", query: "kesh", cursor: first.cursor }, { now: () => clock, deadlineMs: 6000 });
  assert.deepEqual(retry.entries.map(entry => entry.playerId), [id(0), id(1)]); assert.equal(retry.cursor, null);
});

test("deadline between physical pages retains the last fully consumed position", async () => {
  const f = fixture(Array.from({ length: 30 }, (_, index) => row(index, "Kesh"))); let clock = 0;
  f.state.members = 20;
  f.state.onBatch = count => { if (count === 12) clock = 6000; };
  const first = await f.planner.directoryPage({ leagueId: "league", query: "kesh", seasonId: "winter" }, { now: () => clock, deadlineMs: 6000 });
  assert.equal(first.searchIncomplete, true); assert(first.cursor);
  assert.equal(JSON.parse(Buffer.from(first.cursor, "base64url").toString()).sk, identityDirectorySk(id(24)));
});

test("missing or malformed batched identity remains an error, never an incomplete-search fallback", async () => {
  for (const kind of ["missingIdentity", "malformedIdentity"] as const) {
    const f = fixture([row(0, "Kesh")]); f.state[kind] = true;
    await assert.rejects(f.planner.directoryPage({ leagueId: "league", query: "kesh" }), error => (error as { code?: string }).code === "player_identity_unavailable");
  }
});
