import { GetItemCommand, QueryCommand, ScanCommand, TransactWriteItemsCommand, type AttributeValue,
  type GetItemCommandOutput, type QueryCommandOutput, type ScanCommandOutput, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { createHash, randomUUID } from "node:crypto";
import { PlayerIdentityPlanner, PlayerIdentityError, boundedIdentityTransaction, identityCondition, identityPut,
  identityGameSk, identitySeasonKey, identityDirectorySk, identityTombstoneSk, identityLeagueSk,
  type IdentityClient, type IdentitySnapshot, type MembershipContext, type IdentityControl } from "./player-identity.js";

type Item = Record<string, AttributeValue>;
export interface IdentityMigrationManifest {
  migrationId: string; accountId: string; region: string; tableArn: string; tableName: string;
  writerSha: string; reviewedPlan: string; drainedAt: string; writerVersion: 1;
}
interface Totals { count: number; digest: string }
export interface IdentityMigrationAudit {
  manifest: IdentityMigrationManifest;
  phase: "inventory" | "verification" | "ready" | "active" | "blocked";
  pausedEpoch: string;
  cursor: { pk: string; sk: string } | null;
  inventory: Totals; verification: Totals;
  issueCount: number; issues: Array<{ pk: string; sk: string; code: string }>;
}
const emptyTotals = (): Totals => ({ count: 0, digest: "0".repeat(64) });
const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 1024;
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const physicalKey = (pk: unknown, sk: unknown): boolean => typeof pk === "string" && typeof sk === "string" &&
  pk.length > 0 && sk.length > 0 && Buffer.byteLength(pk) <= 2048 && Buffer.byteLength(sk) <= 1024;
function validateReservedType(item: Item): void {
  const pk = item.pk?.S ?? "", sk = item.sk?.S ?? "";
  if (!physicalKey(pk, sk)) fail("migration_invalid_key");
  let expected: string | undefined;
  if (pk.startsWith("GAME#")) {
    if (sk.startsWith("PLAYER#")) expected = "gamePlayer";
    if (sk.startsWith("ROSTER#")) expected = "roster";
  }
  if (pk.startsWith("PLAYER#")) {
    expected = ({ PROFILE: "player", IDENTITY: "playerIdentity", LEAGUE_CREATION: "leaguePlayerCreation" } as Record<string, string>)[sk];
    for (const [prefix, type] of [["GAME#", "playerGameMembership"], ["SEASON#", "playerSeasonMembership"], ["LEAGUE#", "playerLeagueMembership"]]) {
      if (sk.startsWith(prefix)) expected = type;
    }
  }
  if (pk.startsWith("LEAGUE#") && sk.startsWith("PLAYER#")) expected = "leaguePlayer";
  if (pk === "PLAYER_IDENTITY_TOMBSTONE") expected = "playerIdentityTombstone";
  if (expected && item.entityType?.S !== expected) fail("migration_reserved_key_type_mismatch");
}
function fail(code: string): never { throw new PlayerIdentityError(code, 503, "Player migration requires investigation. No coverage was enabled."); }
function decode(item: Item, type: string): Record<string, unknown> {
  if (!item.pk?.S || !item.sk?.S || item.entityType?.S !== type || !item.data?.S) return fail("migration_malformed_record");
  try {
    const value = JSON.parse(item.data.S);
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail("migration_malformed_record");
    return value;
  } catch { return fail("migration_malformed_record"); }
}
function snapshot<T>(item: Item, value: T): IdentitySnapshot<T> {
  return { pk: item.pk!.S!, sk: item.sk!.S!, item, value };
}
function addDigest(totals: Totals, item: Item, scope: unknown): Totals {
  // Commutative addition makes verification independent of DynamoDB scan order.
  // Count plus a 256-bit keyed-record digest detects missing/changed sources;
  // source records themselves are retained, not replaced by this fingerprint.
  const hash = createHash("sha256").update(JSON.stringify([item.pk!.S, item.sk!.S, item.entityType!.S, item.data!.S, scope])).digest("hex");
  return { count: totals.count + 1, digest: ((BigInt(`0x${totals.digest}`) + BigInt(`0x${hash}`)) % (1n << 256n)).toString(16).padStart(64, "0") };
}

// Operator-only repository utility; never exposed as a public or authenticated
// application endpoint. The CLI must independently verify STS/table/deployment
// provenance before constructing this runner, on every start and resume.
export class PlayerIdentityMigration {
  private readonly planner: PlayerIdentityPlanner;
  constructor(private readonly client: IdentityClient, private readonly manifest: IdentityMigrationManifest,
    private readonly now: () => string = () => new Date().toISOString()) {
    if (!/^[a-zA-Z0-9-]{8,80}$/.test(manifest.migrationId) || !/^\d{12}$/.test(manifest.accountId) ||
        !/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(manifest.region) || !/^[A-Za-z0-9_.-]{3,255}$/.test(manifest.tableName) ||
        manifest.tableArn !== `arn:aws:dynamodb:${manifest.region}:${manifest.accountId}:table/${manifest.tableName}` ||
        !/^[a-f0-9]{40}$/.test(manifest.writerSha) || !/^https:\/\/github\.com\/ajfisher\/3fc\/(?:pull|issues)\/\d+(?:#[-\w]+)?$/.test(manifest.reviewedPlan) ||
        !date(manifest.drainedAt) || manifest.writerVersion !== 1) fail("migration_invalid_manifest");
    this.planner = new PlayerIdentityPlanner(client, manifest.tableName);
  }

  private async get(pk: string, sk: string): Promise<Item | null> {
    const result = await this.client.send(new GetItemCommand({ TableName: this.manifest.tableName,
      Key: { pk: { S: pk }, sk: { S: sk } }, ConsistentRead: true })) as GetItemCommandOutput;
    return result.Item ?? null;
  }

  private async audit(): Promise<IdentitySnapshot<IdentityMigrationAudit> | null> {
    const pk = `PLAYER_MIGRATION#${this.manifest.migrationId}`, sk = "AUDIT";
    const item = await this.get(pk, sk);
    if (!item) return null;
    const value = decode(item, "playerIdentityMigration") as unknown as IdentityMigrationAudit;
    if (JSON.stringify(value.manifest) !== JSON.stringify(this.manifest) ||
        !["inventory", "verification", "ready", "active", "blocked"].includes(value.phase) || !text(value.pausedEpoch) ||
        !Number.isSafeInteger(value.issueCount) || value.issueCount < 0 || !Array.isArray(value.issues) || value.issues.length > 100 ||
        ![value.inventory, value.verification].every(total => total && Number.isSafeInteger(total.count) && total.count >= 0 && /^[a-f0-9]{64}$/.test(total.digest)) ||
        (value.cursor !== null && (!value.cursor || !physicalKey(value.cursor.pk, value.cursor.sk)))) fail("migration_invalid_audit");
    return { pk, sk, item, value };
  }

  private assertOwned(control: IdentitySnapshot<IdentityControl>, audit: IdentityMigrationAudit): void {
    if (control.value.mode !== "paused" || control.value.coverage !== "unknown" || control.value.epoch !== audit.pausedEpoch) fail("migration_pause_lost");
  }

  async begin(): Promise<IdentityMigrationAudit> {
    const existing = await this.audit();
    if (existing) {
      if (existing.value.phase !== "active") this.assertOwned(await this.planner.readControl(), existing.value);
      return existing.value;
    }
    const control = await this.planner.readControl();
    if (control.value.mode === "paused") fail("migration_already_owned");
    const pausedEpoch = randomUUID(), now = this.now();
    const value: IdentityMigrationAudit = { manifest: this.manifest, phase: "inventory", pausedEpoch, cursor: null,
      inventory: emptyTotals(), verification: emptyTotals(), issueCount: 0, issues: [] };
    await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction([
      identityPut(this.manifest.tableName, control, "playerIdentityControl", { ...control.value, mode: "paused", coverage: "unknown", epoch: pausedEpoch }, now),
      identityPut(this.manifest.tableName, { pk: `PLAYER_MIGRATION#${this.manifest.migrationId}`, sk: "AUDIT", item: null, value }, "playerIdentityMigration", value, now),
    ]) }));
    return value;
  }

  async status(): Promise<IdentityMigrationAudit | null> { return (await this.audit())?.value ?? null; }

  private async gameContext(gameId: string): Promise<{ game: MembershipContext; item: Item }> {
    const live = await this.get(`GAME#${gameId}`, "METADATA");
    const item = live ?? await this.get("PLAYER_IDENTITY_TOMBSTONE", identityTombstoneSk("game", [gameId]));
    if (!item) return fail("migration_orphan_game");
    const data = decode(item, live ? "game" : "playerIdentityTombstone");
    if (!live && (data.kind !== "game" || JSON.stringify(data.ids) !== JSON.stringify([gameId]))) return fail("migration_invalid_tombstone");
    const game = (live ? data : data.game) as Partial<MembershipContext> | null;
    if (!game || game.gameId !== gameId || !text(game.leagueId) || !text(game.seasonId) || !date(game.gameStartTs)) return fail("migration_invalid_game_scope");
    return { game: { gameId, leagueId: game.leagueId, seasonId: game.seasonId, gameStartTs: game.gameStartTs }, item };
  }

  private async *gameMemberships(playerId: string): AsyncGenerator<Record<string, unknown>> {
    let cursor: Item | undefined;
    do {
      const page = await this.client.send(new QueryCommand({ TableName: this.manifest.tableName, ConsistentRead: true, Limit: 25,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :skPrefix)",
        ExpressionAttributeValues: { ":pk": { S: `PLAYER#${playerId}` }, ":skPrefix": { S: "GAME#" } }, ExclusiveStartKey: cursor })) as QueryCommandOutput;
      for (const item of page.Items ?? []) {
        const member = decode(item, "playerGameMembership");
        if (member.playerId !== playerId || !text(member.gameId) || item.pk?.S !== `PLAYER#${playerId}` || item.sk?.S !== identityGameSk(member.gameId)) fail("migration_invalid_reverse_membership");
        yield member;
      }
      const next = page.LastEvaluatedKey;
      if (next && (next.pk?.S !== `PLAYER#${playerId}` || !next.sk?.S?.startsWith("GAME#") || JSON.stringify(next) === JSON.stringify(cursor))) fail("migration_invalid_cursor");
      cursor = next;
    } while (cursor);
  }

  private async associated(members: string[], leagueId: string, seasonId?: string): Promise<boolean> {
    for (const memberId of members) {
      if (seasonId === undefined) {
        const creation = await this.get(`PLAYER#${memberId}`, "LEAGUE_CREATION");
        if (creation) {
          const record = decode(creation, "leaguePlayerCreation");
          if (record.playerId !== memberId || !text(record.leagueId)) fail("migration_invalid_creation");
          if (record.leagueId === leagueId) return true;
        }
      }
      for await (const game of this.gameMemberships(memberId)) {
        if (game.leagueId === leagueId && (seasonId === undefined || game.seasonId === seasonId)) return true;
      }
    }
    return false;
  }

  private async verifyProjection(item: Item): Promise<void> {
    const type = item.entityType?.S;
    if (!["playerIdentity", "playerGameMembership", "playerSeasonMembership", "playerLeagueMembership", "leaguePlayer"].includes(type ?? "")) return;
    const value = decode(item, type!);
    if (!text(value.playerId)) fail("migration_invalid_projection");
    const playerId = value.playerId;
    const identity = await this.planner.resolve(playerId);
    for (const memberId of identity.root.value.members) {
      const raw = await this.get(`PLAYER#${memberId}`, "PROFILE");
      if (!raw) fail("migration_missing_profile");
      const profile = decode(raw, "player");
      if (profile.playerId !== memberId || !text(profile.nickname) ||
          (profile.claimedByUserId !== null && !text(profile.claimedByUserId))) fail("migration_invalid_profile");
    }
    if (type === "playerIdentity") {
      if (item.pk?.S !== `PLAYER#${playerId}` || item.sk?.S !== "IDENTITY") fail("migration_invalid_projection");
      return;
    }
    if (type === "playerGameMembership") {
      if (!text(value.gameId) || item.pk?.S !== `PLAYER#${playerId}` || item.sk?.S !== identityGameSk(value.gameId)) fail("migration_invalid_reverse_membership");
      const { game } = await this.gameContext(value.gameId);
      if (game.leagueId !== value.leagueId || game.seasonId !== value.seasonId ||
          await this.planner.registeredOriginal(identity, game.gameId) !== playerId) fail("migration_orphan_reverse_membership");
      return;
    }
    if (type === "leaguePlayer") {
      if (!item.pk?.S?.startsWith("LEAGUE#") || item.sk?.S !== identityDirectorySk(playerId) || typeof value.active !== "boolean") fail("migration_invalid_directory");
      if (!value.active) {
        if (identity.root.value.playerId === playerId) fail("migration_inactive_root");
        return;
      }
      const leagueId = item.pk.S.slice("LEAGUE#".length);
      if (identity.root.value.playerId !== playerId || value.nickname !== identity.root.value.displayName ||
          !await this.associated(identity.root.value.members, leagueId)) fail("migration_orphan_directory");
      if (!Array.isArray(value.seasonIds) || value.seasonIds.length > 3 || !value.seasonIds.every(text) ||
          new Set(value.seasonIds).size !== value.seasonIds.length || typeof value.hasMoreSeasons !== "boolean") fail("migration_invalid_directory");
      for (const seasonId of value.seasonIds) {
        if (!await this.associated(identity.root.value.members, leagueId, seasonId)) fail("migration_orphan_season_context");
      }
      return;
    }
    if (!text(value.leagueId) || item.pk?.S !== `PLAYER#${playerId}`) fail("migration_invalid_reverse_membership");
    if (type === "playerSeasonMembership") {
      if (!text(value.seasonId) || item.sk?.S !== identitySeasonKey(value.leagueId, value.seasonId) ||
          !await this.associated([playerId], value.leagueId, value.seasonId)) fail("migration_orphan_season_membership");
    } else if (item.sk?.S !== identityLeagueSk(value.leagueId) ||
        !await this.associated(identity.root.value.members, value.leagueId)) fail("migration_orphan_league_membership");
  }

  private async source(item: Item, audit: IdentitySnapshot<IdentityMigrationAudit>, control: IdentitySnapshot<IdentityControl>,
    verify: boolean): Promise<unknown | undefined> {
    const type = item.entityType?.S;
    if (!["player", "gamePlayer", "roster", "leaguePlayerCreation"].includes(type ?? "")) return undefined;
    const data = decode(item, type!);
    if (!text(data.playerId)) return fail("migration_invalid_player_reference");
    const playerId = data.playerId;
    let game: MembershipContext | undefined, gameItem: Item | undefined, leagueId: string | undefined;
    if (type === "gamePlayer" || type === "roster") {
      if (!text(data.gameId) || item.pk!.S !== `GAME#${data.gameId}` ||
          (type === "gamePlayer" ? item.sk!.S !== `PLAYER#${playerId}` :
            !["red", "blue", "yellow"].includes(String(data.teamId)) || item.sk!.S !== `ROSTER#${data.teamId}#${playerId}`)) return fail("migration_invalid_registration");
      const context = await this.gameContext(data.gameId); game = context.game; gameItem = context.item; leagueId = game.leagueId;
    } else if (type === "leaguePlayerCreation") {
      if (!text(data.leagueId) || item.pk!.S !== `PLAYER#${playerId}` || item.sk!.S !== "LEAGUE_CREATION") return fail("migration_invalid_creation");
      leagueId = data.leagueId;
    } else if (item.pk!.S !== `PLAYER#${playerId}` || item.sk!.S !== "PROFILE") return fail("migration_invalid_profile");
    const profile = type === "player" ? item : await this.get(`PLAYER#${playerId}`, "PROFILE");
    if (!profile) return fail("migration_missing_profile");
    const player = decode(profile, "player");
    if (player.playerId !== playerId || !text(player.nickname) ||
        (player.claimedByUserId !== null && !text(player.claimedByUserId)) ||
        !date(profile.createdAt?.S) || !date(profile.updatedAt?.S)) return fail("migration_invalid_profile");
    const identity = await this.planner.resolve(playerId, player.nickname);
    if (game) await this.planner.registeredOriginal(identity, game.gameId);
    if (verify) {
      if (!identity.original.item || !identity.root.item) return fail("migration_missing_identity");
      if (leagueId) {
        const directory = await this.get(`LEAGUE#${leagueId}`, identityDirectorySk(identity.root.value.playerId));
        const entry = directory ? decode(directory, "leaguePlayer") : null;
        if (!entry || entry.playerId !== identity.root.value.playerId || entry.active !== true ||
            entry.nickname !== identity.root.value.displayName) return fail("migration_missing_directory");
        const league = await this.get(`PLAYER#${identity.root.value.playerId}`, identityLeagueSk(leagueId));
        const leagueData = league ? decode(league, "playerLeagueMembership") : null;
        if (!leagueData || leagueData.playerId !== identity.root.value.playerId || leagueData.leagueId !== leagueId) return fail("migration_missing_league_membership");
      }
      if (game) {
        const membership = await this.get(`PLAYER#${playerId}`, identityGameSk(game.gameId));
        const season = await this.get(`PLAYER#${playerId}`, identitySeasonKey(game.leagueId, game.seasonId));
        const member = membership ? decode(membership, "playerGameMembership") : null;
        const seasonData = season ? decode(season, "playerSeasonMembership") : null;
        if (!member || member.playerId !== playerId || member.gameId !== game.gameId || member.leagueId !== game.leagueId || member.seasonId !== game.seasonId ||
            !seasonData || seasonData.playerId !== playerId || seasonData.leagueId !== game.leagueId || seasonData.seasonId !== game.seasonId) return fail("migration_missing_membership");
      }
    } else {
      const checks: TransactWriteItem[] = [identityCondition(this.manifest.tableName, control), identityCondition(this.manifest.tableName, audit),
        identityCondition(this.manifest.tableName, snapshot(item, data)), identityCondition(this.manifest.tableName, snapshot(profile, player)),
        ...this.planner.planRevision(identity, this.now())];
      if (gameItem) checks.push(identityCondition(this.manifest.tableName, snapshot(gameItem, {})));
      if (leagueId) checks.push(...await this.planner.planDirectory(identity, leagueId, this.now(), game ? { ...game, registeredPlayerId: playerId } : undefined));
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction(checks) }));
    }
    return { playerId, leagueId: leagueId ?? null, game: game ?? null };
  }

  async step(limit = 25): Promise<IdentityMigrationAudit> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail("migration_invalid_page_size");
    const audit = await this.audit(); if (!audit) return fail("migration_not_started");
    const control = await this.planner.readControl(); this.assertOwned(control, audit.value);
    if (!["inventory", "verification"].includes(audit.value.phase)) return audit.value;
    const verify = audit.value.phase === "verification";
    const page = await this.client.send(new ScanCommand({ TableName: this.manifest.tableName, ConsistentRead: true, Limit: limit,
      ExclusiveStartKey: audit.value.cursor ? { pk: { S: audit.value.cursor.pk }, sk: { S: audit.value.cursor.sk } } : undefined })) as ScanCommandOutput;
    const next = structuredClone(audit.value);
    for (const item of page.Items ?? []) {
      try {
        validateReservedType(item);
        if (verify) await this.verifyProjection(item);
        const scope = await this.source(item, audit, control, verify);
        if (scope !== undefined) {
          if (verify) next.verification = addDigest(next.verification, item, scope);
          else next.inventory = addDigest(next.inventory, item, scope);
        }
      } catch (error) {
        // Conditions/network/capacity errors abort without checkpointing. Only
        // bounded validation findings become explicit blocking audit entries.
        if (!(error instanceof PlayerIdentityError)) throw error;
        next.issueCount += 1;
        if (next.issues.length < 100) next.issues.push({ pk: item.pk?.S ?? "invalid-key", sk: item.sk?.S ?? "invalid-key", code: error.code });
      }
    }
    const key = page.LastEvaluatedKey;
    if (key && !physicalKey(key.pk?.S, key.sk?.S)) return fail("migration_invalid_cursor");
    next.cursor = key ? { pk: key.pk!.S!, sk: key.sk!.S! } : null;
    if (!key) {
      if (next.issueCount) next.phase = "blocked";
      else if (!verify) next.phase = "verification";
      else if (JSON.stringify(next.inventory) === JSON.stringify(next.verification)) next.phase = "ready";
      else { next.phase = "blocked"; next.issueCount += 1; next.issues.push({ pk: "inventory", sk: "verification", code: "migration_source_changed" }); }
    }
    await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction([
      identityCondition(this.manifest.tableName, control), identityPut(this.manifest.tableName, audit, "playerIdentityMigration", next, this.now()),
    ]) }));
    return next;
  }

  async activate(): Promise<IdentityMigrationAudit> {
    const audit = await this.audit(); if (!audit) return fail("migration_not_started");
    if (audit.value.phase === "active") return audit.value;
    const control = await this.planner.readControl(); this.assertOwned(control, audit.value);
    if (audit.value.phase !== "ready" || audit.value.issueCount || JSON.stringify(audit.value.inventory) !== JSON.stringify(audit.value.verification)) fail("migration_not_verified");
    const next = { ...audit.value, phase: "active" as const };
    await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction([
      identityPut(this.manifest.tableName, control, "playerIdentityControl", { ...control.value, mode: "fenced", coverage: "verified", epoch: randomUUID() }, this.now()),
      identityPut(this.manifest.tableName, audit, "playerIdentityMigration", next, this.now()),
    ]) }));
    return next;
  }

  async restartBlocked(): Promise<IdentityMigrationAudit> {
    const audit = await this.audit(); if (!audit || audit.value.phase !== "blocked") return fail("migration_not_blocked");
    const control = await this.planner.readControl(); this.assertOwned(control, audit.value);
    const next: IdentityMigrationAudit = { ...audit.value, phase: "inventory", pausedEpoch: randomUUID(), cursor: null,
      inventory: emptyTotals(), verification: emptyTotals(), issueCount: 0, issues: [] };
    const now = this.now();
    // Explicit operator action after investigation, never an automatic retry.
    // Archive the complete failed attempt and invalidate outstanding batches;
    // do not erase profiles, revisions, aliases or partially built projections.
    await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction([
      identityPut(this.manifest.tableName, control, "playerIdentityControl", { ...control.value, epoch: next.pausedEpoch }, now),
      identityPut(this.manifest.tableName, audit, "playerIdentityMigration", next, now),
      identityPut(this.manifest.tableName, { pk: audit.pk, sk: `ATTEMPT#${audit.value.pausedEpoch}`, item: null, value: audit.value },
        "playerIdentityMigrationAttempt", audit.value, now),
    ]) }));
    return next;
  }
}
