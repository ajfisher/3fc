import { GetItemCommand, QueryCommand, type AttributeValue, type QueryCommandOutput, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { IdentityReadCache, type IdentityReadKey } from "./identity-read-cache.js";
import { PlayerIdentityPlanner, PlayerIdentityError, identityCondition, identityGameSk, type IdentityClient } from "./player-identity.js";

type Item = Record<string, AttributeValue>;
export type DirectoryGameSample = { games: Array<{ gameId: string; kickoffAt: string; seasonId: string; seasonName?: string }>; gamesIncomplete: boolean };
const unavailable = (): never => { throw new PlayerIdentityError("player_games_unavailable", 503, "Game details could not be checked. Try again."); };
const validText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const body = (item: Item, type: string): Record<string, unknown> => {
  if (item.entityType?.S !== type) return unavailable();
  try { const value = JSON.parse(item.data?.S ?? "null"); if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable(); return value; }
  catch { return unavailable(); }
};

/** Bounded, explicitly incomplete historical sample; never a latest-game index. */
export async function directoryGameSamples(client: IdentityClient, tableName: string, input: {
  leagueId: string; seasonId?: string; playerIds: string[]; deadlineMs?: number;
}): Promise<{ samples: Map<string, DirectoryGameSample>; checks: TransactWriteItem[] }> {
  if (input.playerIds.length > 10) return unavailable();
  const started = Date.now();
  const deadlineMs = input.deadlineMs ?? started + 6000;
  if (!Number.isFinite(deadlineMs)) return unavailable();
  const budgetExpired = new Error("Game sample scheduling budget exhausted");
  try {
  // Use a distinct private sentinel so only scheduling exhaustion can degrade
  // to an incomplete sample. Malformed/failed storage responses still fail closed.
  const cache = new IdentityReadCache(client, tableName, { deadlineMs, deadlineError: budgetExpired });
  const read = async (pk: string, sk: string) => ((await cache.send(new GetItemCommand({ TableName: tableName,
    Key: { pk: { S: pk }, sk: { S: sk } }, ConsistentRead: true }))) as { Item?: Item }).Item;
  await cache.prefetch([{ pk: "PLAYER_IDENTITY", sk: "CONTROL" }, ...input.playerIds.map(id => ({ pk: `PLAYER#${id}`, sk: "IDENTITY" }))]);
  const planner = new PlayerIdentityPlanner(cache, tableName);
  const control = await planner.readControl(); planner.requireDirectory(control);
  const aliasKeys: IdentityReadKey[] = [];
  for (const id of input.playerIds) {
    const item = await read(`PLAYER#${id}`, "IDENTITY"); if (!item) return unavailable();
    const value = body(item, "playerIdentity"), members = value.members;
    if (!Array.isArray(members) || members.length < 1 || members.length > 20 || !members.every(validText)) return unavailable();
    for (const member of members) aliasKeys.push({ pk: `PLAYER#${member}`, sk: "IDENTITY" });
  }
  await cache.prefetch(aliasKeys);
  const identities = await Promise.all(input.playerIds.map(id => planner.resolve(id)));
  if (identities.some((identity, index) => identity.root.value.playerId !== input.playerIds[index])) return unavailable();
  const samples = new Map(input.playerIds.map(id => [id, { games: [], gamesIncomplete: false } as DirectoryGameSample]));
  type Work = { owner: string; member: string; cursor?: Item };
  const queue: Work[] = [];
  // Round-robin makes a bounded sample useful across rows, not only row one.
  for (let member = 0; member < 20; member++) for (const identity of identities) {
    const id = identity.root.value.members[member]; if (id) queue.push({ owner: identity.root.value.playerId, member: id });
  }
  const refs: Array<{ owner: string; member: string; gameId: string }> = [];
  let queries = 0;
  while (queue.length && queries < 40 && Date.now() < Math.min(started + 4000, deadlineMs - 2000)) {
    const tasks = queue.splice(0, Math.min(4, 40 - queries)); queries += tasks.length;
    const settled = await Promise.allSettled(tasks.map(async work => {
      const pk = `PLAYER#${work.member}`;
      const page = await client.send(new QueryCommand({ TableName: tableName, ConsistentRead: true, Limit: 10,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
        ExpressionAttributeValues: { ":pk": { S: pk }, ":prefix": { S: "GAME#" } }, ExclusiveStartKey: work.cursor })) as QueryCommandOutput;
      const items = page.Items ?? []; if (!Array.isArray(items) || items.length > 10) return unavailable();
      let previous = work.cursor?.sk?.S;
      for (const item of items) {
        const value = body(item, "playerGameMembership");
        if (!validText(value.gameId) || value.playerId !== work.member || item.pk?.S !== pk ||
            item.sk?.S !== identityGameSk(value.gameId) || (previous && item.sk.S <= previous) || !validText(value.leagueId) || !validText(value.seasonId)) return unavailable();
        previous = item.sk.S;
        if (value.leagueId === input.leagueId && (input.seasonId === undefined || value.seasonId === input.seasonId)) refs.push({ owner: work.owner, member: work.member, gameId: value.gameId });
      }
      const next = page.LastEvaluatedKey && Object.keys(page.LastEvaluatedKey).length ? page.LastEvaluatedKey : undefined;
      if (next) {
        if (next.pk?.S !== pk || !next.sk?.S?.startsWith("GAME#") || Buffer.byteLength(next.sk.S) > 1024 ||
            (work.cursor?.sk?.S && next.sk.S <= work.cursor.sk.S) || (previous && next.sk.S < previous)) return unavailable();
        queue.push({ ...work, cursor: next });
      }
    }));
    for (const result of settled) if (result.status === "rejected") throw result.reason;
  }
  for (const work of queue) samples.get(work.owner)!.gamesIncomplete = true;
  // Shared enrichment budget, not a multiplier per row/alias. At most500 raw
  // game/registration keys are prefetched, while omitted owners remain explicit.
  const selectedRefs = refs.slice(0, 100);
  for (const ref of refs.slice(100)) samples.get(ref.owner)!.gamesIncomplete = true;
  const gameKeys: IdentityReadKey[] = [];
  for (const ref of selectedRefs) {
    gameKeys.push({ pk: `GAME#${ref.gameId}`, sk: "METADATA" });
    for (const sk of [`PLAYER#${ref.member}`, ...["red", "blue", "yellow"].map(team => `ROSTER#${team}#${ref.member}`)]) {
      if (Buffer.byteLength(sk) <= 1024) gameKeys.push({ pk: `GAME#${ref.gameId}`, sk });
    }
  }
  await cache.prefetch(gameKeys);
  const seen = new Map<string, Map<string, string>>();
  for (const ref of selectedRefs) {
    const item = await read(`GAME#${ref.gameId}`, "METADATA"); if (!item) continue; // Deleted game, not a live destination.
    const game = body(item, "game");
    if (game.gameId !== ref.gameId || !validText(game.leagueId) || !validText(game.seasonId) || !validText(game.gameStartTs) || !Number.isFinite(Date.parse(game.gameStartTs))) return unavailable();
    if (game.leagueId !== input.leagueId || (input.seasonId !== undefined && game.seasonId !== input.seasonId)) continue;
    let registered = false;
    for (const [prefix, type] of [["PLAYER#", "gamePlayer"], ["ROSTER#red#", "roster"], ["ROSTER#blue#", "roster"], ["ROSTER#yellow#", "roster"]]) {
      const sk = `${prefix}${ref.member}`; if (Buffer.byteLength(sk) > 1024) continue;
      const registration = await read(`GAME#${ref.gameId}`, sk); if (!registration) continue;
      const value = body(registration, type!);
      if (value.gameId !== ref.gameId || value.playerId !== ref.member || (type === "roster" && value.teamId !== prefix!.split("#")[1])) return unavailable();
      registered = true;
    }
    if (!registered) continue;
    const group = seen.get(ref.owner) ?? new Map<string, string>();
    if (group.has(ref.gameId)) { if (group.get(ref.gameId) !== ref.member) return unavailable(); continue; }
    group.set(ref.gameId, ref.member); seen.set(ref.owner, group);
    const sample = samples.get(ref.owner)!;
    if (sample.games.length === 20) { sample.gamesIncomplete = true; continue; }
    sample.games.push({ gameId: ref.gameId, kickoffAt: game.gameStartTs, seasonId: game.seasonId });
  }
  for (const sample of samples.values()) sample.games.sort((a, b) => b.kickoffAt.localeCompare(a.kickoffAt) || a.gameId.localeCompare(b.gameId));
  return { samples, checks: [identityCondition(tableName, control), ...identities.map(identity => identityCondition(tableName, identity.root))] };
  } catch (error) {
    if (error !== budgetExpired) throw error;
    // Do not hide an otherwise valid league search because optional context was
    // too expensive. Discard partial date snapshots rather than overclaim them.
    return { samples: new Map(input.playerIds.map(id => [id, { games: [], gamesIncomplete: true }])), checks: [] };
  }
}
