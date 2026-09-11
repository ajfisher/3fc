import { GetItemCommand, QueryCommand, type AttributeValue, type GetItemCommandOutput, type QueryCommandOutput, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { createHash, randomUUID } from "node:crypto";

// Transaction planning only. The repository owns the single commit containing
// both the original domain writes and these identity/membership fences.
type Item = Record<string, AttributeValue>;
export interface IdentityClient { send(command: unknown): Promise<unknown> }
export interface IdentitySnapshot<T> { pk: string; sk: string; item: Item | null; value: T }
export interface IdentityControl {
  mode: "compatible" | "paused" | "fenced";
  epoch: string;
  coverage: "unknown" | "verified";
  writerVersion: 1;
}
export interface PlayerIdentity {
  playerId: string;
  rootId: string;
  members: string[];
  identityVersion: number;
  writeVersion: string;
  displayName: string;
  formerNames: string[];
}
export interface ResolvedPlayerIdentity {
  original: IdentitySnapshot<PlayerIdentity>;
  root: IdentitySnapshot<PlayerIdentity>;
}
export interface PlayerDirectoryEntry {
  playerId: string;
  nickname: string;
  formerNames: string[];
  active: boolean;
  seasonIds?: string[];
  hasMoreSeasons?: boolean;
}
export interface MembershipContext { gameId: string; leagueId: string; seasonId: string; gameStartTs: string; registeredPlayerId?: string }
const projectionKey = (prefix: string, ...ids: string[]): string => `${prefix}#${createHash("sha256").update(JSON.stringify(ids)).digest("hex")}`;
export const identitySeasonKey = (leagueId: string, seasonId: string): string => projectionKey("SEASON", leagueId, seasonId);
export const identityDirectorySk = (playerId: string): string => projectionKey("PLAYER", playerId);
export const identityGameSk = (gameId: string): string => projectionKey("GAME", gameId);
export const identityLeagueSk = (leagueId: string): string => projectionKey("LEAGUE", leagueId);
export const identityTombstoneSk = (kind: "game" | "season" | "league", ids: string[]): string => projectionKey(kind, ...ids);
export class PlayerIdentityError extends Error {
  constructor(readonly code: string, readonly status: 400 | 403 | 404 | 409 | 503, message: string) { super(message); }
  get category(): string {
    return { 400: "bad_request", 403: "forbidden", 404: "not_found", 409: "conflict", 503: "unavailable" }[this.status];
  }
}
export const IDENTITY_CONTROL_KEY = { pk: "PLAYER_IDENTITY", sk: "CONTROL" } as const;
export const IDENTITY_MAX_MEMBERS = 20;

function invalid(message = "Player identity information is unavailable. Please try again later."): never {
  throw new PlayerIdentityError("player_identity_unavailable", 503, message);
}
function keyBudget(pk: string, sk: string): void {
  if (!pk || !sk || Buffer.byteLength(pk) > 2048 || Buffer.byteLength(sk) > 1024) invalid("Player identity key is too large.");
}
function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 1024 && Buffer.byteLength(value) <= 1800;
}
function strings(value: unknown, maximum: number): value is string[] {
  return Array.isArray(value) && value.length <= maximum && value.every(text) && new Set(value).size === value.length;
}
function date(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}
function directoryEntry(value: unknown, playerId: string): PlayerDirectoryEntry {
  const entry = value as Partial<PlayerDirectoryEntry> | null;
  if (!entry || !text(entry.playerId) || entry.playerId !== playerId || !text(entry.nickname) ||
      !strings(entry.formerNames, 20) || typeof entry.active !== "boolean") return invalid();
  if ((entry.seasonIds !== undefined && !strings(entry.seasonIds, 3)) ||
      (entry.hasMoreSeasons !== undefined && typeof entry.hasMoreSeasons !== "boolean")) return invalid();
  return entry as PlayerDirectoryEntry;
}
function parse(item: Item, pk: string, sk: string, entityType: string): unknown {
  if (item.pk?.S !== pk || item.sk?.S !== sk || item.entityType?.S !== entityType || !item.data?.S) return invalid();
  try { return JSON.parse(item.data.S); } catch { return invalid(); }
}
export function validateIdentity(value: unknown, playerId: string): PlayerIdentity {
  const v = value as Partial<PlayerIdentity> | null;
  if (!v || v.playerId !== playerId || !text(v.rootId) || !text(v.playerId) ||
      !Number.isSafeInteger(v.identityVersion) || v.identityVersion! < 0 || !text(v.writeVersion) ||
      !text(v.displayName) || !strings(v.formerNames, IDENTITY_MAX_MEMBERS) || !strings(v.members, IDENTITY_MAX_MEMBERS)) return invalid();
  if (v.rootId === playerId ? !v.members.includes(playerId) : v.members.length !== 0) return invalid();
  return v as PlayerIdentity;
}
export function validateControl(value: unknown): IdentityControl {
  const v = value as Partial<IdentityControl> | null;
  if (!v || !["compatible", "paused", "fenced"].includes(v.mode ?? "") || !text(v.epoch) ||
      !["unknown", "verified"].includes(v.coverage ?? "") || v.writerVersion !== 1 ||
      (v.coverage === "verified" && v.mode !== "fenced")) return invalid();
  return v as IdentityControl;
}
export function identityItem(pk: string, sk: string, entityType: string, value: unknown, now: string, createdAt = now): Item {
  return { pk: { S: pk }, sk: { S: sk }, entityType: { S: entityType }, data: { S: JSON.stringify(value) },
    createdAt: { S: createdAt }, updatedAt: { S: now } };
}
export function identityCondition(tableName: string, snapshot: IdentitySnapshot<unknown>): TransactWriteItem {
  const Key = { pk: { S: snapshot.pk }, sk: { S: snapshot.sk } };
  return { ConditionCheck: snapshot.item ? {
    TableName: tableName, Key, ConditionExpression: "#data = :data AND #type = :type",
    ExpressionAttributeNames: { "#data": "data", "#type": "entityType" },
    ExpressionAttributeValues: { ":data": snapshot.item.data!, ":type": snapshot.item.entityType! },
  } : { TableName: tableName, Key, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } };
}
export function identityPut(tableName: string, snapshot: IdentitySnapshot<unknown>, entityType: string, value: unknown, now: string): TransactWriteItem {
  const check = identityCondition(tableName, snapshot).ConditionCheck!;
  const { Key: _key, ...condition } = check;
  return { Put: { ...condition, Item: identityItem(snapshot.pk, snapshot.sk, entityType, value, now, snapshot.item?.createdAt?.S ?? now) } };
}

// Refuse conflicting actions instead of accidentally updating a root twice in
// one DynamoDB transaction. Identical condition checks may be shared by plans.
export function boundedIdentityTransaction(actions: TransactWriteItem[]): TransactWriteItem[] {
  const byKey = new Map<string, TransactWriteItem>();
  for (const action of actions) {
    const operations = [action.Put, action.Update, action.Delete, action.ConditionCheck].filter(Boolean);
    if (operations.length !== 1) return invalid("Invalid identity transaction.");
    const op = operations[0]!;
    const key = action.Put?.Item ?? (op as { Key?: Item }).Key;
    if (!key?.pk?.S || !key.sk?.S || !op.TableName) return invalid("Invalid identity transaction key.");
    keyBudget(key.pk.S, key.sk.S);
    const id = JSON.stringify([op.TableName, key.pk.S, key.sk.S]);
    const previous = byKey.get(id);
    if (previous) {
      if (previous.ConditionCheck && action.ConditionCheck && JSON.stringify(previous) === JSON.stringify(action)) continue;
      return invalid("Conflicting identity transaction actions.");
    }
    if (action.Put && Buffer.byteLength(JSON.stringify(action.Put.Item)) > 350_000) return invalid("Identity record is too large.");
    byKey.set(id, action);
  }
  const result = [...byKey.values()];
  // Conservative serialized limits leave room for attribute names and DynamoDB
  // encoding. Never split an atomic identity operation to make it fit.
  if (result.length > 100 || Buffer.byteLength(JSON.stringify(result)) > 3_500_000) return invalid("Identity transaction is too large.");
  return result;
}

export class PlayerIdentityPlanner {
  constructor(private readonly client: IdentityClient, private readonly tableName: string) {}

  private async get(pk: string, sk: string): Promise<Item | null> {
    keyBudget(pk, sk);
    const response = await this.client.send(new GetItemCommand({ TableName: this.tableName,
      Key: { pk: { S: pk }, sk: { S: sk } }, ConsistentRead: true })) as GetItemCommandOutput;
    return response.Item ?? null;
  }

  async readControl(): Promise<IdentitySnapshot<IdentityControl>> {
    const { pk, sk } = IDENTITY_CONTROL_KEY;
    const item = await this.get(pk, sk);
    return { pk, sk, item, value: item ? validateControl(parse(item, pk, sk, "playerIdentityControl")) :
      { mode: "compatible", epoch: "legacy", coverage: "unknown", writerVersion: 1 } };
  }

  private async record<T>(pk: string, sk: string, entityType: string, missing: T): Promise<IdentitySnapshot<T>> {
    const item = await this.get(pk, sk);
    return { pk, sk, item, value: item ? parse(item, pk, sk, entityType) as T : missing };
  }

  async planDirectory(identity: ResolvedPlayerIdentity, leagueId: string, now: string,
    game?: MembershipContext, requireExisting = false): Promise<TransactWriteItem[]> {
    if (!text(leagueId) || (game && (game.leagueId !== leagueId || !text(game.gameId) ||
        !text(game.seasonId) || !date(game.gameStartTs)))) return invalid();
    const playerId = identity.root.value.playerId;
    const pk = `PLAYER#${playerId}`;
    const directory = await this.record<PlayerDirectoryEntry>(`LEAGUE#${leagueId}`, identityDirectorySk(playerId), "leaguePlayer", {
      playerId, nickname: identity.root.value.displayName, formerNames: identity.root.value.formerNames,
      active: true, seasonIds: [], hasMoreSeasons: false,
    });
    const entry = directoryEntry(directory.value, playerId);
    if (requireExisting && !directory.item) throw new PlayerIdentityError("player_unavailable", 409, "Choose a player from this league.");
    if (!entry.active) return invalid();
    const revision = await this.record(`LEAGUE#${leagueId}`, "PLAYER_DIRECTORY", "playerDirectoryRevision", { revision: "legacy" });
    if (!revision.value || !text(revision.value.revision)) return invalid();
    const league = await this.record(pk, identityLeagueSk(leagueId), "playerLeagueMembership", { playerId, leagueId });
    if (!league.value || league.value.playerId !== playerId || league.value.leagueId !== leagueId) return invalid();
    const actions: TransactWriteItem[] = [];
    if (game) {
      const memberId = game.registeredPlayerId ?? playerId;
      if (!identity.root.value.members.includes(memberId)) return invalid();
      const memberPk = `PLAYER#${memberId}`;
      const membership = await this.record(memberPk, identityGameSk(game.gameId), "playerGameMembership", { ...game, playerId: memberId });
      if (!membership.value || membership.value.playerId !== memberId || membership.value.gameId !== game.gameId ||
          membership.value.leagueId !== leagueId || membership.value.seasonId !== game.seasonId || !date(membership.value.gameStartTs)) return invalid();
      const season = await this.record(memberPk, identitySeasonKey(leagueId, game.seasonId), "playerSeasonMembership",
        { playerId: memberId, leagueId, seasonId: game.seasonId });
      if (!season.value || season.value.playerId !== memberId || season.value.leagueId !== leagueId || season.value.seasonId !== game.seasonId) return invalid();
      actions.push(identityPut(this.tableName, membership, "playerGameMembership", membership.value, now),
        identityPut(this.tableName, season, "playerSeasonMembership", season.value, now));
    }
    const seasons = [...new Set([...(entry.seasonIds ?? []), ...(game ? [game.seasonId] : [])])]
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    actions.push(identityPut(this.tableName, directory, "leaguePlayer", {
      ...entry, nickname: identity.root.value.displayName, formerNames: identity.root.value.formerNames,
      seasonIds: seasons.slice(0, 3), hasMoreSeasons: entry.hasMoreSeasons === true || seasons.length > 3,
    }, now), identityPut(this.tableName, league, "playerLeagueMembership", league.value, now),
    identityPut(this.tableName, revision, "playerDirectoryRevision", { revision: randomUUID() }, now));
    return actions;
  }

  async registeredOriginal(identity: ResolvedPlayerIdentity, gameId: string): Promise<string | null> {
    if (!text(gameId)) return invalid();
    const matches: string[] = [];
    for (const member of identity.root.value.members) {
      const item = await this.get(`GAME#${gameId}`, `PLAYER#${member}`);
      let present = Boolean(item);
      if (item) {
        const value = parse(item, `GAME#${gameId}`, `PLAYER#${member}`, "gamePlayer") as { gameId?: unknown; playerId?: unknown };
        if (!value || value.gameId !== gameId || value.playerId !== member) return invalid();
      }
      for (const teamId of ["red", "blue", "yellow"]) {
        const sk = `ROSTER#${teamId}#${member}`;
        const roster = await this.get(`GAME#${gameId}`, sk);
        if (!roster) continue;
        const value = parse(roster, `GAME#${gameId}`, sk, "roster") as Record<string, unknown>;
        if (!value || value.gameId !== gameId || value.playerId !== member || value.teamId !== teamId) return invalid();
        present = true;
      }
      if (present) matches.push(member);
    }
    if (matches.length > 1) return invalid("This player has conflicting registrations. Ask the organiser for help.");
    return matches[0] ?? null;
  }

  async directoryPage(input: { leagueId: string; seasonId?: string; gameId?: string; query?: string; cursor?: string; limit?: number }): Promise<{
    entries: Array<PlayerDirectoryEntry & { inGame?: boolean }>; cursor: string | null;
  }> {
    const { leagueId, seasonId } = input;
    const query = input.query?.trim().toLocaleLowerCase("en-AU") ?? "";
    const limit = input.limit ?? 25;
    if (!text(leagueId) || (seasonId !== undefined && !text(seasonId)) || (input.gameId !== undefined && !text(input.gameId)) || query.length > 100 ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new PlayerIdentityError("invalid_player_search", 400, "Check the player search.");
    const control = await this.readControl(); this.requireDirectory(control);
    const pk = `LEAGUE#${leagueId}`;
    const revision = await this.record(pk, "PLAYER_DIRECTORY", "playerDirectoryRevision", { revision: "legacy" });
    if (!revision.value || !text(revision.value.revision)) return invalid();
    let ExclusiveStartKey: Item | undefined;
    if (input.cursor) {
      try {
        if (input.cursor.length > 8000 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error();
        const cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
        if (cursor.version !== 1 || cursor.leagueId !== leagueId || cursor.seasonId !== (seasonId ?? null) || (cursor.gameId ?? null) !== (input.gameId ?? null) ||
            cursor.query !== query || !text(cursor.sk) || !cursor.sk.startsWith("PLAYER#")) throw new Error();
        if (cursor.revision !== revision.value.revision || cursor.epoch !== control.value.epoch) {
          throw new PlayerIdentityError("player_search_changed", 409, "The player list changed. Search again.");
        }
        ExclusiveStartKey = { pk: { S: pk }, sk: { S: cursor.sk } };
      } catch (error) {
        if (error instanceof PlayerIdentityError) throw error;
        throw new PlayerIdentityError("invalid_player_cursor", 400, "Start a new player search.");
      }
    }
    const page = await this.client.send(new QueryCommand({ TableName: this.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :skPrefix)",
      ExpressionAttributeValues: { ":pk": { S: pk }, ":skPrefix": { S: "PLAYER#" } },
      ConsistentRead: true, Limit: limit, ExclusiveStartKey })) as QueryCommandOutput;
    const entries: Array<PlayerDirectoryEntry & { inGame?: boolean }> = [];
    for (const item of page.Items ?? []) {
      if (item.pk?.S !== pk || !item.sk?.S?.startsWith("PLAYER#")) return invalid();
      const raw = parse(item, pk, item.sk.S, "leaguePlayer") as PlayerDirectoryEntry;
      const entry = directoryEntry(raw, raw?.playerId);
      if (item.sk.S !== identityDirectorySk(entry.playerId)) return invalid();
      if (!entry.active || ![entry.nickname, ...entry.formerNames].some(name => name.toLocaleLowerCase("en-AU").includes(query))) continue;
      const identity = await this.resolve(entry.playerId);
      if (identity.root.value.playerId !== entry.playerId) return invalid();
      if (seasonId) {
        let included = false;
        for (const member of identity.root.value.members) {
          const marker = await this.get(`PLAYER#${member}`, identitySeasonKey(leagueId, seasonId));
          if (!marker) continue;
          const value = parse(marker, `PLAYER#${member}`, identitySeasonKey(leagueId, seasonId), "playerSeasonMembership") as Record<string, unknown>;
          if (!value || value.playerId !== member || value.leagueId !== leagueId || value.seasonId !== seasonId) return invalid();
          included = true;
        }
        if (!included) continue;
      }
      entries.push({ ...entry, ...(input.gameId === undefined ? {} : { inGame: await this.registeredOriginal(identity, input.gameId) !== null }) });
    }
    const [after, afterControl] = await Promise.all([
      this.record(pk, "PLAYER_DIRECTORY", "playerDirectoryRevision", { revision: "legacy" }), this.readControl(),
    ]);
    if (!after.value || !text(after.value.revision)) return invalid();
    if (after.value.revision !== revision.value.revision || JSON.stringify(afterControl.value) !== JSON.stringify(control.value)) {
      throw new PlayerIdentityError("player_search_changed", 409, "The player list changed. Search again.");
    }
    const key = page.LastEvaluatedKey;
    if (key && (key.pk?.S !== pk || !key.sk?.S?.startsWith("PLAYER#"))) return invalid();
    return { entries, cursor: key ? Buffer.from(JSON.stringify({ version: 1, leagueId, seasonId: seasonId ?? null, gameId: input.gameId ?? null,
      query, revision: revision.value.revision, epoch: control.value.epoch, sk: key.sk!.S })).toString("base64url") : null };
  }

  writableControl(control: IdentitySnapshot<IdentityControl>): TransactWriteItem {
    if (control.value.mode === "paused") throw new PlayerIdentityError("player_writes_paused", 503,
      "Player updates are temporarily paused. Please try again shortly.");
    return identityCondition(this.tableName, control);
  }

  requireCoverage(control: IdentitySnapshot<IdentityControl>): void {
    if (!control.item || control.value.mode !== "fenced" || control.value.coverage !== "verified") {
      throw new PlayerIdentityError("player_directory_preparing", 503, "The player list is being prepared. Please try again shortly.");
    }
  }

  requireDirectory(control: IdentitySnapshot<IdentityControl>): void {
    // Only audited cutover enters fenced mode. Later deletion invalidates merge
    // coverage, but retained historical league/season associations stay valid
    // for reuse. Directory presentation must not claim live game counts/dates.
    if (!control.item || control.value.mode !== "fenced") {
      throw new PlayerIdentityError("player_directory_preparing", 503, "The player list is being prepared. Please try again shortly.");
    }
  }

  async resolve(playerId: string, fallbackName?: string): Promise<ResolvedPlayerIdentity> {
    if (!text(playerId)) throw new PlayerIdentityError("invalid_player_id", 400, "Choose a valid player.");
    const pk = `PLAYER#${playerId}`, sk = "IDENTITY";
    const item = await this.get(pk, sk);
    if (!item) {
      if (!text(fallbackName)) return invalid();
      const root = { pk, sk, item: null, value: { playerId, rootId: playerId, members: [playerId],
        identityVersion: 0, writeVersion: "legacy", displayName: fallbackName, formerNames: [] } };
      return { original: root, root };
    }
    const original = { pk, sk, item, value: validateIdentity(parse(item, pk, sk, "playerIdentity"), playerId) };
    if (original.value.rootId === playerId) { await this.verifyMembers(original); return { original, root: original }; }
    const rootId = original.value.rootId, rootPk = `PLAYER#${rootId}`;
    const rootItem = await this.get(rootPk, sk);
    if (!rootItem) return invalid();
    const root = { pk: rootPk, sk, item: rootItem, value: validateIdentity(parse(rootItem, rootPk, sk, "playerIdentity"), rootId) };
    // Consolidation rewrites the complete bounded alias closure atomically.
    // Chains, cycles and unlisted aliases are corruption, not partial groups.
    if (root.value.rootId !== rootId || !root.value.members.includes(playerId)) return invalid();
    await this.verifyMembers(root);
    return { original, root };
  }

  private async verifyMembers(root: IdentitySnapshot<PlayerIdentity>): Promise<void> {
    for (const member of root.value.members) {
      if (member === root.value.playerId) continue;
      const pk = `PLAYER#${member}`;
      const item = await this.get(pk, "IDENTITY");
      if (!item) return invalid();
      const alias = validateIdentity(parse(item, pk, "IDENTITY", "playerIdentity"), member);
      if (alias.rootId !== root.value.playerId) return invalid();
    }
  }

  planRevision(identity: ResolvedPlayerIdentity, now: string, ownershipChanged = false): TransactWriteItem[] {
    const version = identity.root.value.identityVersion + (ownershipChanged ? 1 : 0);
    if (!Number.isSafeInteger(version)) return invalid();
    return [
      ...(identity.original.pk !== identity.root.pk ? [identityCondition(this.tableName, identity.original)] : []),
      identityPut(this.tableName, identity.root, "playerIdentity", {
        ...identity.root.value, identityVersion: version, writeVersion: randomUUID(),
      }, now),
    ];
  }

  planCoverageInvalidation(control: IdentitySnapshot<IdentityControl>, now: string): TransactWriteItem {
    this.writableControl(control);
    return identityPut(this.tableName, control, "playerIdentityControl", {
      ...control.value, epoch: randomUUID(), coverage: "unknown",
    }, now);
  }

  planStructureChange(control: IdentitySnapshot<IdentityControl>, now: string): TransactWriteItem {
    this.writableControl(control);
    // Structure creation is infrequent. Advancing the shared epoch also fences
    // legacy sessions without a league field: a delete cannot commit using an
    // emptiness read made before a concurrent child was created.
    return identityPut(this.tableName, control, "playerIdentityControl", { ...control.value, epoch: randomUUID() }, now);
  }

  async liveScope(kind: "game" | "season" | "league", ids: string[]): Promise<TransactWriteItem> {
    if (!ids.every(text) || ids.length !== (kind === "season" ? 2 : 1)) return invalid();
    const snapshot = await this.record("PLAYER_IDENTITY_TOMBSTONE", identityTombstoneSk(kind, ids), "playerIdentityTombstone", { kind, ids });
    if (snapshot.item) throw new PlayerIdentityError("player_context_deleted", 409, "This game or league is no longer available.");
    return identityCondition(this.tableName, snapshot);
  }

  async planDeletion(kind: "game" | "season" | "league", ids: string[], now: string,
    game?: Omit<MembershipContext, "registeredPlayerId">,
    expectedControl?: IdentitySnapshot<IdentityControl>): Promise<TransactWriteItem[]> {
    if (!ids.every(text) || ids.length !== (kind === "season" ? 2 : 1)) return invalid();
    // Registrations and event targets survive game deletion. Retain only the
    // original membership scope so reconciliation never has to guess its league
    // from an opaque ID. This is not a public result or a games-played count.
    if (kind === "game" ? !game || game.gameId !== ids[0] || !text(game.leagueId) ||
        !text(game.seasonId) || !date(game.gameStartTs) : game !== undefined) return invalid();
    const value = { kind, ids, ...(game ? { game } : {}) };
    const control = expectedControl ?? await this.readControl();
    const snapshot = await this.record("PLAYER_IDENTITY_TOMBSTONE", identityTombstoneSk(kind, ids), "playerIdentityTombstone", value);
    if (JSON.stringify(snapshot.value) !== JSON.stringify(value)) return invalid();
    return [this.planCoverageInvalidation(control, now), identityPut(this.tableName, snapshot, "playerIdentityTombstone", snapshot.value, now)];
  }
}
