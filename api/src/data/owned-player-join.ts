import { GetItemCommand, QueryCommand, TransactWriteItemsCommand, type GetItemCommandOutput, type QueryCommandOutput, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { createHash } from "node:crypto";
import { TEAM_IDS, type TeamId } from "@3fc/contracts";
import { identityCondition, identityPut, identityDirectorySk, identityLeagueSk, boundedIdentityTransaction,
  PlayerIdentityPlanner, PlayerIdentityError, validPlayerIdentityId, type IdentityClient, type IdentitySnapshot,
  type ResolvedPlayerIdentity } from "./player-identity.js";
import { playerClaimSk } from "./keys.js";
import { readPlayerClaimsRevision } from "./player-claims-revision.js";

type Data = Record<string, unknown>;
type Snap = IdentitySnapshot<Data>;
type Game = { gameId: string; leagueId: string; seasonId: string; gameStartTs: string; joinCode: string };
export type OwnedJoinTeam = { teamId: TeamId; name: string; color: string | null };
export interface OwnedJoinPlayer { playerId: string; nickname: string; registeredPlayerId: string | null; team: OwnedJoinTeam | null; seasons: Array<{ seasonId: string; name: string }> }
export interface OwnedJoinPage { accountId: string; gameId: string; leagueId: string; players: OwnedJoinPlayer[]; cursor: string | null; complete: boolean }
export interface OwnedJoinResult { accountId: string; gameId: string; joinCode: string; player: { playerId: string; nickname: string }; link: { gameId: string; playerId: string }; alreadyRegistered: boolean; team: OwnedJoinTeam | null }
type MembershipPlan = (game: Game, id: string, nickname: string, now: string) => Promise<{ playerId: string; identity: ResolvedPlayerIdentity; actions: TransactWriteItem[] }>;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const fail = (code = "owned_players_unavailable", status: 400 | 403 | 404 | 409 | 503 = 503, message = "Your linked players could not be checked. Try again."): never => { throw new PlayerIdentityError(code, status, message); };
const changed = (): never => fail("owned_players_changed", 409, "Your linked players changed. Check them again.");
function conditional(error: unknown): boolean {
  const e = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  return e?.name === "ConditionalCheckFailedException" || (e?.name === "TransactionCanceledException" &&
    Boolean(e.CancellationReasons?.some(r => r.Code === "ConditionalCheckFailed")) &&
    e.CancellationReasons!.every(r => !r.Code || ["None", "ConditionalCheckFailed"].includes(r.Code)));
}

/** Private current-account discovery and join-code-authorized self-registration. */
export class OwnedPlayerJoinService {
  private readonly planner: PlayerIdentityPlanner;
  constructor(private readonly client: IdentityClient, private readonly tableName: string, private readonly now: () => string,
    private readonly membershipPlan: MembershipPlan, private readonly enabled = false) { this.planner = new PlayerIdentityPlanner(client, tableName); }
  private requireEnabled(): void { if (!this.enabled) fail("returning_join_unavailable", 503, "Joining with a linked player is temporarily unavailable. Try again later."); }
  private accounts(input: { userId: string; userIds?: readonly string[] }): string[] {
    const ids = [...new Set([input.userId, ...(input.userIds ?? [])])];
    if (ids.length > 2 || !ids.every(text)) return fail("invalid_account", 400, "Sign in again.");
    return ids;
  }
  private async read(pk: string, sk: string, type: string): Promise<Snap | null> {
    if (Buffer.byteLength(pk) > 2048 || Buffer.byteLength(sk) > 1024) return fail();
    const item = ((await this.client.send(new GetItemCommand({ TableName: this.tableName, Key: { pk: { S: pk }, sk: { S: sk } }, ConsistentRead: true }))) as GetItemCommandOutput).Item;
    if (!item) return null;
    let value: Data;
    try { value = JSON.parse(item.data?.S ?? "null"); } catch { return fail(); }
    if (item.pk?.S !== pk || item.sk?.S !== sk || item.entityType?.S !== type || !value || typeof value !== "object" || Array.isArray(value)) return fail();
    return { pk, sk, item, value };
  }
  private async scope(rawCode: string) {
    const joinCode = rawCode.trim().toUpperCase();
    if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(joinCode)) return fail("invalid_join_code", 400, "Check your join link.");
    const code = await this.read(`JOIN_CODE#${joinCode}`, "METADATA", "gameJoinCode");
    if (!code || !text(code.value.gameId)) return fail("join_unavailable", 404, "This join link is unavailable.");
    const game = await this.read(`GAME#${code.value.gameId}`, "METADATA", "game");
    if (!game || game.value.gameId !== code.value.gameId || game.value.joinCode !== joinCode) return fail("join_unavailable", 404, "This join link is unavailable.");
    if (![game.value.gameId, game.value.leagueId, game.value.seasonId, game.value.gameStartTs].every(text)) return fail();
    const league = await this.read(`LEAGUE#${game.value.leagueId}`, "METADATA", "league");
    if (!league || league.value.leagueId !== game.value.leagueId) return fail("join_unavailable", 404, "This join link is unavailable.");
    const control = await this.planner.readControl(); this.planner.requireDirectory(control);
    // A newly created, still-empty league has no projection revision yet.
    // Fence that absence so its first membership cannot slip between pages.
    const directory: Snap = await this.read(`LEAGUE#${game.value.leagueId}`, "PLAYER_DIRECTORY", "playerDirectoryRevision") ??
      { pk: `LEAGUE#${game.value.leagueId}`, sk: "PLAYER_DIRECTORY", item: null, value: { revision: "legacy" } };
    if (!text(directory.value.revision)) return fail();
    return { code, game, league, control, directory, value: game.value as Game, joinCode };
  }
  private async owned(playerId: string, userIds: readonly string[], leagueId: string) {
    if (!validPlayerIdentityId(playerId)) return fail("invalid_player_id", 400, "Choose a linked player.");
    const identity = await this.planner.resolve(playerId);
    const rootId = identity.root.value.playerId;
    const profile = await this.read(`PLAYER#${rootId}`, "PROFILE", "player");
    if (!profile || profile.value.playerId !== rootId || !text(profile.value.nickname)) return fail();
    if (!userIds.includes(profile.value.claimedByUserId as string)) return null;
    const directory = await this.read(`LEAGUE#${leagueId}`, identityDirectorySk(rootId), "leaguePlayer");
    if (!directory) return null;
    if (directory.value.playerId !== rootId || directory.value.active !== true || !text(directory.value.nickname)) return fail();
    const membership = await this.read(`PLAYER#${rootId}`, identityLeagueSk(leagueId), "playerLeagueMembership");
    if (!membership || membership.value.playerId !== rootId || membership.value.leagueId !== leagueId) return fail();
    return { identity, profile, directory, membership, rootId, nickname: identity.root.value.displayName };
  }
  private async team(gameId: string, playerId: string | null): Promise<OwnedJoinTeam | null> {
    if (playerId === null) return null;
    let found: OwnedJoinTeam | null = null;
    for (const teamId of TEAM_IDS) {
      const sk = `ROSTER#${teamId}#${playerId}`;
      if (Buffer.byteLength(sk) > 1024) continue;
      const assignment = await this.read(`GAME#${gameId}`, sk, "roster");
      if (!assignment) continue;
      if (found || assignment.value.playerId !== playerId || assignment.value.gameId !== gameId || assignment.value.teamId !== teamId) return fail();
      const team = await this.read(`GAME#${gameId}`, `TEAM#${teamId}`, "gameTeam");
      if (!team || team.value.teamId !== teamId || !text(team.value.name) || (team.value.color !== null && typeof team.value.color !== "string")) return fail();
      found = { teamId, name: team.value.name, color: team.value.color as string | null };
    }
    return found;
  }
  async list(input: { joinCode: string; userId: string; userIds?: readonly string[]; cursor?: string; limit?: number }): Promise<OwnedJoinPage> {
    this.requireEnabled();
    const accounts = this.accounts(input), scope = await this.scope(input.joinCode);
    const revisions = await Promise.all(accounts.map(id => readPlayerClaimsRevision(this.client, this.tableName, id)));
    const limit = input.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) return fail("invalid_page_size", 400, "Start a new player search.");
    const binding = hash([accounts, scope.joinCode, scope.value.gameId, scope.value.leagueId]);
    const versions = [...revisions.map(r => r.value.revision), scope.control.value.epoch, scope.directory.value.revision];
    let namespace = "PLAYER#", accountIndex = 0, sk: string | undefined;
    if (input.cursor) {
      try {
        if (input.cursor.length > 8000 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error();
        const c = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8"));
        if (c.v !== 1 || c.binding !== binding || !Number.isInteger(c.accountIndex) || c.accountIndex < 0 || c.accountIndex >= accounts.length || !["PLAYER#", "PLAYER_HASH#"].includes(c.namespace) ||
          (c.sk !== null && (!text(c.sk) || !c.sk.startsWith(c.namespace) || Buffer.byteLength(c.sk) > 1024))) throw new Error();
        if (JSON.stringify(c.versions) !== JSON.stringify(versions)) return changed();
        namespace = c.namespace; accountIndex = c.accountIndex; sk = c.sk ?? undefined;
      } catch (error) { if (error instanceof PlayerIdentityError) throw error; return fail("invalid_player_cursor", 400, "Start a new player search."); }
    }
    const pk = `USER#${accounts[accountIndex]}`;
    const page = await this.client.send(new QueryCommand({ TableName: this.tableName, ConsistentRead: true, Limit: limit,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": { S: pk }, ":prefix": { S: namespace } },
      ...(sk ? { ExclusiveStartKey: { pk: { S: pk }, sk: { S: sk } } } : {}) })) as QueryCommandOutput;
    const checks = [identityCondition(this.tableName, scope.code), identityCondition(this.tableName, scope.game), identityCondition(this.tableName, scope.league),
      identityCondition(this.tableName, scope.control), identityCondition(this.tableName, scope.directory), ...revisions.map(revision => identityCondition(this.tableName, revision))];
    const source = page.Items ?? [];
    if (source.length > limit || source.length > 20) return fail();
    // Validate the whole bounded source page before launching lookups. Each
    // entry performs sequential reads, so at most 20 DynamoDB calls overlap.
    // Twenty is the existing source-page/transaction budget, not a new pool
    // multiplier for each of its up-to-20 underlying aliases.
    const claims = source.map(item => {
      let claim: Data;
      try { claim = JSON.parse(item.data?.S ?? "null"); } catch { return fail(); }
      if (!claim || item.pk?.S !== pk || item.entityType?.S !== "playerClaim" || claim.userId !== accounts[accountIndex] ||
        !validPlayerIdentityId(claim.playerId) || item.sk?.S !== playerClaimSk(claim.playerId) || !item.sk.S.startsWith(namespace)) return fail();
      return claim.playerId;
    });
    const resolved = await Promise.allSettled(claims.map(async playerId => {
      const owned = await this.owned(playerId, accounts, scope.value.leagueId);
      if (!owned) return null;
      const original = await this.planner.registeredOriginal(owned.identity, scope.value.gameId);
      const seasons: OwnedJoinPlayer["seasons"] = [];
      const ids = owned.directory.value.seasonIds ?? [];
      if (!Array.isArray(ids) || ids.length > 3 || !ids.every(text)) return fail();
      for (const id of ids) {
        if (Buffer.byteLength(`SEASON#${id}`) > 1024) return fail();
        const season = await this.read(`LEAGUE#${scope.value.leagueId}`, `SEASON#${id}`, "season");
        if (season && season.value.seasonId === id && text(season.value.name)) seasons.push({ seasonId: id, name: season.value.name });
      }
      return { rootId: owned.rootId,
        checks: [identityCondition(this.tableName, owned.identity.root), identityCondition(this.tableName, owned.profile), identityCondition(this.tableName, owned.directory)],
        player: { playerId: owned.rootId, nickname: owned.nickname, registeredPlayerId: original, team: await this.team(scope.value.gameId, original), seasons } };
    }));
    // Wait for every bounded read task, including on failure; never return a
    // partial page or leave detached lookups after a rejected sibling task.
    const players: OwnedJoinPlayer[] = [], seen = new Set<string>();
    for (const result of resolved) {
      if (result.status === "rejected") throw result.reason;
      if (!result.value || seen.has(result.value.rootId)) continue;
      seen.add(result.value.rootId);
      checks.push(...result.value.checks); players.push(result.value.player);
    }
    const last = page.LastEvaluatedKey;
    if (last && (last.pk?.S !== pk || !last.sk?.S?.startsWith(namespace) || Buffer.byteLength(last.sk.S) > 1024 ||
        (sk && Buffer.compare(Buffer.from(last.sk.S), Buffer.from(sk)) <= 0))) return fail();
    const next = last ? { accountIndex, namespace, sk: last.sk!.S } : namespace === "PLAYER#" ? { accountIndex, namespace: "PLAYER_HASH#", sk: null }
      : accountIndex + 1 < accounts.length ? { accountIndex: accountIndex + 1, namespace: "PLAYER#", sk: null } : null;
    try { await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction(checks) })); }
    catch (error) { if (conditional(error)) return changed(); throw error; }
    return { accountId: input.userId, gameId: scope.value.gameId, leagueId: scope.value.leagueId, players,
      cursor: next ? Buffer.from(JSON.stringify({ v: 1, binding, versions, ...next })).toString("base64url") : null, complete: next === null };
  }
  async join(input: { joinCode: string; userId: string; userIds?: readonly string[]; playerId: string; idempotencyKey: string }): Promise<OwnedJoinResult> {
    this.requireEnabled(); const accounts = this.accounts(input);
    if (!text(input.idempotencyKey) || input.idempotencyKey.length > 200) return fail("invalid_idempotency_key", 400, "Retry with the original join request.");
    await Promise.all(accounts.map(id => readPlayerClaimsRevision(this.client, this.tableName, id))); // Validate private account keys before any receipt lookup.
    for (let attempt = 0; attempt < 3; attempt++) {
      const scope = await this.scope(input.joinCode), now = this.now();
      const pk = `GAME#${scope.value.gameId}`, sk = `OWNED_JOIN#${hash([input.userId, input.idempotencyKey])}`;
      const fingerprint = hash([scope.joinCode, input.playerId]);
      const receipt = await this.read(pk, sk, "ownedPlayerJoinReceipt");
      const selected = await this.owned(input.playerId, accounts, scope.value.leagueId);
      if (!selected) return fail("player_not_owned", 403, "Choose one of your linked players in this league.");
      const baseChecks = [identityCondition(this.tableName, scope.code), identityCondition(this.tableName, scope.game), identityCondition(this.tableName, scope.league),
        identityCondition(this.tableName, scope.control), identityCondition(this.tableName, selected.profile)];
      if (receipt) {
        if (receipt.value.userId !== input.userId || receipt.value.requestHash !== fingerprint) return fail("join_request_conflict", 409, "This join request has changed. Retry the original request.");
        const result = receipt.value.result as OwnedJoinResult;
        if (!result || result.accountId !== input.userId || result.gameId !== scope.value.gameId || result.joinCode !== scope.joinCode ||
          !result.player || !text(result.player.nickname) || !validPlayerIdentityId(result.player.playerId) || result.link?.gameId !== scope.value.gameId ||
          result.link.playerId !== result.player.playerId || typeof result.alreadyRegistered !== "boolean") return fail();
        const original = await this.planner.registeredOriginal(selected.identity, scope.value.gameId);
        if (original !== result.player.playerId) return changed();
        try { await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction([...baseChecks,
          identityCondition(this.tableName, selected.identity.root), identityCondition(this.tableName, selected.directory), identityCondition(this.tableName, receipt)]) })); }
        catch (error) { if (conditional(error)) continue; throw error; }
        return result;
      }
      if (selected.rootId !== input.playerId) return changed();
      const plan = await this.membershipPlan(scope.value, input.playerId, selected.nickname, now);
      if (JSON.stringify(plan.identity.root.value) !== JSON.stringify(selected.identity.root.value)) return changed();
      const original = await this.planner.registeredOriginal(plan.identity, scope.value.gameId);
      const registered = original ?? plan.identity.root.value.playerId;
      const result: OwnedJoinResult = { accountId: input.userId, gameId: scope.value.gameId, joinCode: scope.joinCode,
        player: { playerId: registered, nickname: selected.nickname }, link: { gameId: scope.value.gameId, playerId: registered },
        alreadyRegistered: original !== null, team: await this.team(scope.value.gameId, original) };
      const actions = [...plan.actions, ...baseChecks,
        identityPut(this.tableName, { pk, sk, item: null, value: {} }, "ownedPlayerJoinReceipt", { userId: input.userId, requestHash: fingerprint, result }, now)];
      if (!original) actions.push(identityPut(this.tableName, { pk, sk: `PLAYER#${registered}`, item: null, value: {} }, "gamePlayer", { gameId: scope.value.gameId, playerId: registered }, now));
      try { await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction(actions) })); return result; }
      catch (error) { if (conditional(error)) continue; throw error; }
    }
    return changed();
  }
}
