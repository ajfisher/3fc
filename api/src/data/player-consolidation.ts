import { GetItemCommand, QueryCommand, TransactWriteItemsCommand, type AttributeValue,
  type GetItemCommandOutput, type QueryCommandOutput, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { createHash, randomUUID } from "node:crypto";
import { PlayerIdentityPlanner, PlayerIdentityError, identityCondition, identityPut, identityDirectorySk,
  identityGameSk, identityLeagueSk, boundedIdentityTransaction, validPlayerIdentityId,
  type IdentityClient, type IdentitySnapshot, type PlayerIdentity, type IdentityControl } from "./player-identity.js";
import { playerClaimSk } from "./keys.js";

type Item = Record<string, AttributeValue>;
type RecordData = Record<string, unknown>;
type Snap = IdentitySnapshot<RecordData>;
type State = "pending_approval" | "ready" | "declined" | "committed";
export interface ConsolidationProfile {
  playerId: string; nickname: string; claimed: boolean;
  games: Array<{ gameId: string; kickoffAt: string }>;
}
export interface ConsolidationView {
  proposalId: string; leagueId: string; leagueName: string; retainedPlayerId: string; nickname: string;
  status: State | "stale"; profiles: ConsolidationProfile[]; blockers: Array<{ code: string; message: string }>;
  requiresApproval: boolean; canApprove: boolean; canCommit: boolean;
}
export interface ConsolidationPreviewInput {
  proposalId: string; leagueId: string; playerIds: string[]; retainedPlayerId: string; nickname: string; userIds: readonly string[];
}
interface Member { id: string; identity: IdentitySnapshot<PlayerIdentity>; profile: Snap; directory: Snap }
interface Context {
  control: IdentitySnapshot<IdentityControl>; league: Snap; acl: Snap; members: Member[];
  roots: string[]; ownerId: string | null; profiles: ConsolidationProfile[]; seasons: string[]; formerNames: string[];
}
interface Proposal {
  version: 1; proposalId: string; leagueId: string; leagueName: string; actorId: string; issuerId: string;
  ownerId: string | null; playerIds: string[]; retainedPlayerId: string; nickname: string;
  expiresAt: string; epoch: string; profiles: ConsolidationProfile[];
  expected: Array<{ id: string; identity: string; profile: string; directory: string }>;
  state: State; approvedBy: string | null; digest: string;
}
const TTL = 24 * 60 * 60 * 1000;
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const validProposalId = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{20,64}$/.test(v);
const hash = (v: unknown): string => createHash("sha256").update(JSON.stringify(v)).digest("hex");
const fingerprint = (s: IdentitySnapshot<unknown>): string => hash(s.item ?
  [s.pk, s.sk, s.item.entityType?.S, s.item.data?.S, s.item.createdAt?.S, s.item.updatedAt?.S] : null);
function fail(code: string, message: string, status: 400 | 403 | 404 | 409 | 503 = 409): never {
  throw new PlayerIdentityError(code, status, message);
}
const unavailable = (): never => fail("consolidation_unavailable", "These player profiles could not be checked. Try again later.", 503);
function immutable(p: Proposal): unknown {
  return [p.version, p.proposalId, p.leagueId, p.leagueName, p.actorId, p.issuerId, p.ownerId,
    p.playerIds, p.retainedPlayerId, p.nickname, p.expiresAt, p.epoch, p.profiles, p.expected];
}
function cancelled(error: unknown): boolean {
  const e = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  return e?.name === "ConditionalCheckFailedException" || (e?.name === "TransactionCanceledException" &&
    Boolean(e.CancellationReasons?.some(r => r.Code === "ConditionalCheckFailed")) &&
    e.CancellationReasons!.every(r => !r.Code || ["None", "ConditionalCheckFailed"].includes(r.Code)));
}

/** All normal writes belong to one bounded transaction. No historical record is rewritten. */
export class PlayerConsolidationService {
  private readonly planner: PlayerIdentityPlanner;
  constructor(private readonly client: IdentityClient, private readonly tableName: string,
    private readonly now: () => string = () => new Date().toISOString(), private readonly enabled = false) {
    this.planner = new PlayerIdentityPlanner(client, tableName);
  }
  private requireEnabled(): void {
    if (!this.enabled) fail("consolidation_disabled", "Combining profiles is temporarily unavailable.", 503);
  }
  private actor(userIds: readonly string[]): string {
    if (!userIds.length || userIds.some(id => !text(id))) fail("consolidation_forbidden", "Sign in to continue.", 403);
    return userIds[0];
  }
  private decode(item: Item, pk: string, sk: string, type: string): Snap {
    if (item.pk?.S !== pk || item.sk?.S !== sk || item.entityType?.S !== type || !item.data?.S) return unavailable();
    let value: RecordData;
    try { value = JSON.parse(item.data.S); } catch { return unavailable(); }
    if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable();
    return { pk, sk, item, value };
  }
  private async read(pk: string, sk: string, type: string): Promise<Snap | null> {
    if (Buffer.byteLength(pk) > 2048 || Buffer.byteLength(sk) > 1024) return unavailable();
    const response = await this.client.send(new GetItemCommand({ TableName: this.tableName,
      Key: { pk: { S: pk }, sk: { S: sk } }, ConsistentRead: true })) as GetItemCommandOutput;
    return response.Item ? this.decode(response.Item, pk, sk, type) : null;
  }
  private async authority(leagueId: string, userIds: readonly string[], exactIssuer?: string): Promise<{ league: Snap; acl: Snap }> {
    this.actor(userIds);
    const league = await this.read(`LEAGUE#${leagueId}`, "METADATA", "league");
    if (!league || league.value.leagueId !== leagueId || !text(league.value.name)) {
      fail("consolidation_forbidden", "You cannot manage these player profiles.", 403);
    }
    for (const id of exactIssuer ? [exactIssuer] : [...new Set(userIds)]) {
      if (!userIds.includes(id)) continue;
      const acl = await this.read(`LEAGUE#${leagueId}`, `ACL#USER#${id}`, "acl");
      if (acl?.value.leagueId === leagueId && acl.value.userId === id && acl.value.role === "admin") return { league, acl };
    }
    return fail("consolidation_forbidden", "Only a league organiser can combine player profiles.", 403);
  }
  private async *references(playerId: string): AsyncGenerator<Snap> {
    let cursor: Item | undefined, count = 0;
    const seen = new Set<string>();
    do {
      const page = await this.client.send(new QueryCommand({ TableName: this.tableName, ConsistentRead: true, Limit: 50,
        KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": { S: `PLAYER#${playerId}` } },
        ExclusiveStartKey: cursor })) as QueryCommandOutput;
      for (const item of page.Items ?? []) {
        if (++count > 2000) fail("consolidation_too_large", "This player history needs organiser support before it can be combined.");
        if (item.pk?.S !== `PLAYER#${playerId}` || !item.sk?.S) return unavailable();
        const type = item.sk.S.startsWith("GAME#") ? "playerGameMembership" :
          item.sk.S.startsWith("LEAGUE#") ? "playerLeagueMembership" : item.sk.S === "LEAGUE_CREATION" ? "leaguePlayerCreation" : null;
        if (type) yield this.decode(item, item.pk.S, item.sk.S, type);
      }
      cursor = page.LastEvaluatedKey;
      if (cursor) {
        if (cursor.pk?.S !== `PLAYER#${playerId}` || !cursor.sk?.S || seen.has(cursor.sk.S)) return unavailable();
        seen.add(cursor.sk.S);
      }
    } while (cursor);
  }
  private async inspect(input: ConsolidationPreviewInput, issuer?: string): Promise<Context> {
    const authority = await this.authority(input.leagueId, input.userIds, issuer);
    const control = await this.planner.readControl(); this.planner.requireCoverage(control);
    const roots = new Map<string, IdentitySnapshot<PlayerIdentity>>();
    for (const id of input.playerIds) {
      const resolved = await this.planner.resolve(id);
      roots.set(resolved.root.value.playerId, resolved.root);
    }
    if (roots.size < 2 || !roots.has(input.retainedPlayerId)) fail("consolidation_selection", "Choose at least two different profiles and a retained profile.");
    const ids = [...new Set([...roots.values()].flatMap(root => root.value.members))].sort();
    if (ids.length > 20) fail("consolidation_too_large", "Combine no more than 20 underlying player profiles.");
    const members: Member[] = [], owners = new Set<string>(), profiles: ConsolidationProfile[] = [];
    const games = new Map<string, string>(), seasons = new Set<string>(), names = new Set<string>();
    for (const id of ids) {
      const identity = (await this.planner.resolve(id)).original;
      if (!identity.item || !roots.has(identity.value.rootId)) return unavailable();
      if (roots.has(id) && fingerprint(identity) !== fingerprint(roots.get(id)!)) {
        fail("proposal_stale", "The player profiles changed. Prepare a new proposal.");
      }
      const profile = await this.read(`PLAYER#${id}`, "PROFILE", "player");
      if (!profile || profile.value.playerId !== id || !text(profile.value.nickname) ||
          (profile.value.claimedByUserId !== null && !text(profile.value.claimedByUserId))) return unavailable();
      if (text(profile.value.claimedByUserId)) owners.add(profile.value.claimedByUserId);
      const directory = await this.read(`LEAGUE#${input.leagueId}`, identityDirectorySk(id), "leaguePlayer");
      if (!directory || directory.value.playerId !== id || directory.value.active !== (identity.value.rootId === id)) {
        fail("consolidation_selection", "Choose player profiles from this league.");
      }
      names.add(profile.value.nickname); names.add(identity.value.displayName);
      for (const name of identity.value.formerNames) names.add(name);
      const listed: ConsolidationProfile = { playerId: id, nickname: profile.value.nickname,
        claimed: profile.value.claimedByUserId !== null, games: [] };
      let associated = false;
      for await (const reference of this.references(id)) {
        const value = reference.value;
        if (value.playerId !== id || !text(value.leagueId)) return unavailable();
        if (value.leagueId !== input.leagueId) fail("consolidation_external_history", "These profiles cannot be combined within this league.");
        associated = true;
        if (reference.item!.entityType!.S === "playerGameMembership") {
          if (!text(value.gameId) || !text(value.seasonId) || !text(value.gameStartTs) || !Number.isFinite(Date.parse(value.gameStartTs)) ||
              reference.sk !== identityGameSk(value.gameId)) return unavailable();
          if (games.has(value.gameId) && games.get(value.gameId) !== id) fail("consolidation_game_overlap", "These profiles already appear in the same game.");
          games.set(value.gameId, id); seasons.add(value.seasonId);
          listed.games.push({ gameId: value.gameId, kickoffAt: value.gameStartTs });
        } else if (reference.item!.entityType!.S === "playerLeagueMembership" && reference.sk !== identityLeagueSk(value.leagueId)) return unavailable();
      }
      if (!associated && identity.value.rootId === id) return unavailable();
      listed.games.sort((a, b) => a.kickoffAt.localeCompare(b.kickoffAt) || a.gameId.localeCompare(b.gameId));
      profiles.push(listed); members.push({ id, identity, profile, directory });
    }
    if (owners.size > 1) fail("consolidation_different_owners", "These profiles are linked to different accounts and cannot be combined.");
    const ownerId = [...owners][0] ?? null;
    if (ownerId && members.find(member => member.id === input.retainedPlayerId)!.profile.value.claimedByUserId !== ownerId) {
      fail("consolidation_retain_claimed", "Retain the profile already linked to the player's account.");
    }
    names.delete(input.nickname);
    if (names.size > 20) fail("consolidation_too_large", "This name history needs organiser support before it can be combined.");
    return { ...authority, control, members, roots: [...roots.keys()].sort(), ownerId, profiles,
      seasons: [...seasons].sort(), formerNames: [...names].sort() };
  }
  private expected(context: Context): Proposal["expected"] {
    return context.members.map(member => ({ id: member.id, identity: fingerprint(member.identity),
      profile: fingerprint(member.profile), directory: fingerprint(member.directory) }));
  }
  private checks(context: Context): TransactWriteItem[] {
    return [identityCondition(this.tableName, context.control), identityCondition(this.tableName, context.league),
      identityCondition(this.tableName, context.acl), ...context.members.flatMap(m => [identityCondition(this.tableName, m.identity),
        identityCondition(this.tableName, m.profile), identityCondition(this.tableName, m.directory)])];
  }
  private async proposal(id: string): Promise<IdentitySnapshot<Proposal>> {
    if (!validProposalId(id)) fail("invalid_proposal", "Choose a valid profile proposal.", 400);
    const stored = await this.read(`PLAYER_CONSOLIDATION#${id}`, "PROPOSAL", "playerConsolidation");
    if (!stored) fail("proposal_not_found", "This profile proposal is not available.", 404);
    const p = stored.value as unknown as Proposal;
    if (p.version !== 1 || p.proposalId !== id || !text(p.leagueId) || !text(p.leagueName) || !text(p.actorId) || !text(p.issuerId) ||
        (p.ownerId !== null && !text(p.ownerId)) || !validPlayerIdentityId(p.retainedPlayerId) || !text(p.nickname) ||
        !text(p.expiresAt) || !Number.isFinite(Date.parse(p.expiresAt)) || !text(p.epoch) ||
        !Array.isArray(p.playerIds) || p.playerIds.length < 2 || p.playerIds.length > 20 || !p.playerIds.every(validPlayerIdentityId) ||
        !Array.isArray(p.expected) || p.expected.length < 2 || p.expected.length > 20 ||
        p.expected.some(m => !m || !validPlayerIdentityId(m.id) || ![m.identity, m.profile, m.directory].every(h => typeof h === "string" && /^[a-f0-9]{64}$/.test(h))) ||
        !Array.isArray(p.profiles) || p.profiles.length !== p.expected.length ||
        p.profiles.some(m => !m || !validPlayerIdentityId(m.playerId) || !text(m.nickname) || typeof m.claimed !== "boolean" || !Array.isArray(m.games) ||
          m.games.some(g => !g || !text(g.gameId) || !text(g.kickoffAt) || !Number.isFinite(Date.parse(g.kickoffAt)))) ||
        !["pending_approval", "ready", "declined", "committed"].includes(p.state) ||
        (p.approvedBy !== null && p.approvedBy !== p.ownerId) ||
        (p.ownerId !== null && ["ready", "committed"].includes(p.state) && p.approvedBy !== p.ownerId) || p.digest !== hash(immutable(p))) return unavailable();
    return { ...stored, value: p };
  }
  private view(p: Proposal, userIds: readonly string[], admin: boolean, stale?: PlayerIdentityError): ConsolidationView {
    const owner = p.ownerId !== null && userIds.includes(p.ownerId);
    return { proposalId: p.proposalId, leagueId: p.leagueId, leagueName: p.leagueName,
      retainedPlayerId: p.retainedPlayerId, nickname: p.nickname, profiles: p.profiles,
      status: stale ? "stale" : p.state, blockers: stale ? [{ code: stale.code, message: stale.message }] : [],
      requiresApproval: p.ownerId !== null, canApprove: this.enabled && !stale && owner && p.state === "pending_approval",
      canCommit: this.enabled && !stale && admin && userIds.includes(p.actorId) && p.state === "ready" };
  }
  private async current(p: Proposal): Promise<Context> {
    if (Date.parse(p.expiresAt) <= Date.parse(this.now())) fail("proposal_expired", "This proposal has expired. Ask the organiser to prepare it again.");
    const context = await this.inspect({ ...p, userIds: [p.actorId, p.issuerId] }, p.issuerId);
    if (context.control.value.epoch !== p.epoch || hash(this.expected(context)) !== hash(p.expected) || context.ownerId !== p.ownerId) {
      fail("proposal_stale", "The player profiles changed. Ask the organiser to prepare a new proposal.");
    }
    return context;
  }
  async preview(input: ConsolidationPreviewInput): Promise<ConsolidationView> {
    this.requireEnabled(); const actorId = this.actor(input.userIds);
    if (!validProposalId(input.proposalId) || !validPlayerIdentityId(input.retainedPlayerId) || !text(input.leagueId) ||
        !Array.isArray(input.playerIds) || input.playerIds.length < 2 || input.playerIds.length > 20 || !input.playerIds.every(validPlayerIdentityId) ||
        new Set(input.playerIds).size !== input.playerIds.length || !text(input.nickname) || input.nickname.length > 80 || input.nickname !== input.nickname.trim()) {
      fail("invalid_proposal", "Choose the profiles to combine and a player name.", 400);
    }
    const existing = await this.read(`PLAYER_CONSOLIDATION#${input.proposalId}`, "PROPOSAL", "playerConsolidation");
    if (existing) {
      const prior = await this.proposal(input.proposalId);
      if (prior.value.actorId !== actorId || prior.value.leagueId !== input.leagueId || prior.value.retainedPlayerId !== input.retainedPlayerId ||
          prior.value.nickname !== input.nickname || hash(prior.value.playerIds) !== hash([...input.playerIds].sort())) fail("proposal_request_changed", "This proposal request changed. Prepare a new proposal.");
      return this.get({ proposalId: input.proposalId, userIds: input.userIds });
    }
    const context = await this.inspect(input);
    const p: Proposal = { version: 1, proposalId: input.proposalId, leagueId: input.leagueId, leagueName: context.league.value.name as string,
      actorId, issuerId: context.acl.value.userId as string, ownerId: context.ownerId, playerIds: [...input.playerIds].sort(),
      retainedPlayerId: input.retainedPlayerId, nickname: input.nickname, expiresAt: new Date(Date.parse(this.now()) + TTL).toISOString(),
      epoch: context.control.value.epoch, profiles: context.profiles, expected: this.expected(context),
      state: context.ownerId ? "pending_approval" : "ready", approvedBy: null, digest: "" };
    p.digest = hash(immutable(p));
    const stored: IdentitySnapshot<Proposal> = { pk: `PLAYER_CONSOLIDATION#${p.proposalId}`, sk: "PROPOSAL", item: null, value: p };
    // Preflight the eventual atomic operation before asking anyone to approve.
    await this.commitPlan(context, stored);
    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction([
        ...this.checks(context), identityPut(this.tableName, stored, "playerConsolidation", p, this.now()),
      ]) }));
    } catch (error) {
      if (cancelled(error)) fail("proposal_stale", "The player profiles changed. Prepare a new proposal.");
      throw error;
    }
    return this.view(p, input.userIds, true);
  }
  async get(input: { proposalId: string; userIds: readonly string[] }): Promise<ConsolidationView> {
    this.actor(input.userIds); const stored = await this.proposal(input.proposalId), p = stored.value;
    let access: { league: Snap; acl: Snap } | null = null;
    try { access = await this.authority(p.leagueId, input.userIds); }
    catch (error) { if (!(error instanceof PlayerIdentityError) || error.status !== 403) throw error; }
    if (!access && !(p.ownerId !== null && input.userIds.includes(p.ownerId))) fail("proposal_not_found", "This profile proposal is not available.", 404);
    const viewerChecks = access ? [identityCondition(this.tableName, access.league), identityCondition(this.tableName, access.acl)] : [];
    // The caller may be another administrator, not the proposal's issuer. Fence
    // that caller's own grant before exposing even a stale/terminal proposal.
    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction([
        ...viewerChecks, identityCondition(this.tableName, stored),
      ]) }));
    } catch (error) {
      if (cancelled(error)) fail("proposal_not_found", "This profile proposal is not available. Reload before trying again.", 404);
      throw error;
    }
    let stale: PlayerIdentityError | undefined;
    if (!["declined", "committed"].includes(p.state)) {
      try { const context = await this.current(p); await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction([
        ...this.checks(context), identityCondition(this.tableName, stored),
      ]) })); }
      catch (error) {
        if (error instanceof PlayerIdentityError) stale = error;
        else if (cancelled(error)) stale = new PlayerIdentityError("proposal_stale", 409, "The player profiles changed. Prepare a new proposal.");
        else throw error;
      }
    }
    return this.view(p, input.userIds, access !== null, stale);
  }
  async decide(input: { proposalId: string; decision: "approve" | "decline"; userIds: readonly string[] }): Promise<ConsolidationView> {
    this.requireEnabled(); this.actor(input.userIds);
    if (!["approve", "decline"].includes(input.decision)) fail("invalid_proposal", "Choose approve or decline.", 400);
    const stored = await this.proposal(input.proposalId), p = stored.value;
    if (!p.ownerId || !input.userIds.includes(p.ownerId)) fail("proposal_not_found", "This profile proposal is not available.", 404);
    const nextState = input.decision === "approve" ? "ready" : "declined";
    if (p.state === nextState && p.approvedBy === p.ownerId) return this.get(input);
    if (p.state !== "pending_approval") fail("proposal_decided", "This proposal has already been decided.");
    const context = await this.current(p);
    const next: Proposal = { ...p, state: nextState, approvedBy: p.ownerId };
    if (Date.parse(p.expiresAt) <= Date.parse(this.now())) fail("proposal_expired", "This proposal has expired. Prepare a new proposal.");
    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction([
        ...this.checks(context), identityPut(this.tableName, stored, "playerConsolidation", next, this.now()),
      ]) }));
    } catch (error) { if (cancelled(error)) fail("proposal_stale", "The proposal changed. Check it before deciding again."); throw error; }
    return this.view(next, input.userIds, input.userIds.includes(p.actorId) && input.userIds.includes(p.issuerId));
  }
  private async commitPlan(context: Context, stored: IdentitySnapshot<Proposal>): Promise<TransactWriteItem[]> {
    const p = stored.value, now = this.now(), retained = context.members.find(m => m.id === p.retainedPlayerId)!;
    const actions: TransactWriteItem[] = [identityCondition(this.tableName, context.control), identityCondition(this.tableName, context.league),
      identityCondition(this.tableName, context.acl)];
    const after: PlayerIdentity[] = [];
    const indexesBefore: Array<{ playerId: string; record: RecordData | null }> = [];
    for (const m of context.members) {
      const isRoot = m.id === p.retainedPlayerId;
      const next: PlayerIdentity = { ...m.identity.value, rootId: p.retainedPlayerId, members: isRoot ? context.members.map(x => x.id) : [],
        identityVersion: m.identity.value.identityVersion + 1, writeVersion: randomUUID(),
        displayName: isRoot ? p.nickname : m.identity.value.displayName, formerNames: isRoot ? context.formerNames : m.identity.value.formerNames };
      if (!Number.isSafeInteger(next.identityVersion)) return unavailable();
      after.push(next);
      actions.push(identityPut(this.tableName, m.identity, "playerIdentity", next, now), identityCondition(this.tableName, m.profile),
        identityPut(this.tableName, m.directory, "leaguePlayer", { ...m.directory.value, active: isRoot,
          ...(isRoot ? { nickname: p.nickname, formerNames: context.formerNames, seasonIds: context.seasons.slice(0, 3), hasMoreSeasons: context.seasons.length > 3 } : {}) }, now));
      if (p.ownerId) {
        const pk = `USER#${p.ownerId}`, sk = playerClaimSk(m.id);
        const index = await this.read(pk, sk, "playerClaim");
        if (index && (index.value.userId !== p.ownerId || index.value.playerId !== m.id)) return unavailable();
        indexesBefore.push({ playerId: m.id, record: index?.value ?? null });
        if (isRoot) actions.push(identityPut(this.tableName, index ?? { pk, sk, item: null, value: {} }, "playerClaim", { userId: p.ownerId, playerId: m.id }, now));
        else if (index) actions.push({ Delete: identityCondition(this.tableName, index).ConditionCheck! });
      }
    }
    const revision = await this.read(`LEAGUE#${p.leagueId}`, "PLAYER_DIRECTORY", "playerDirectoryRevision");
    if (!revision || !text(revision.value.revision)) return unavailable();
    actions.push(identityPut(this.tableName, revision, "playerDirectoryRevision", { revision: randomUUID() }, now));
    // Existing member reverse records remain unchanged and are read as a union.
    const league = await this.read(`PLAYER#${retained.id}`, identityLeagueSk(p.leagueId), "playerLeagueMembership");
    if (!league || league.value.playerId !== retained.id || league.value.leagueId !== p.leagueId) return unavailable();
    actions.push(identityCondition(this.tableName, league));
    actions.push(identityPut(this.tableName, stored, "playerConsolidation", { ...p, state: "committed" }, now));
    const audit = { proposalId: p.proposalId, digest: p.digest, actorId: p.actorId, approvedBy: p.approvedBy, at: now,
      before: context.members.map(m => m.identity.value), after,
      directoryBefore: context.members.map(m => m.directory.value), indexesBefore,
      indexesAfter: p.ownerId ? [{ userId: p.ownerId, playerId: retained.id }] : [] };
    actions.push(identityPut(this.tableName, { pk: stored.pk, sk: "AUDIT", item: null, value: {} }, "playerConsolidationAudit", audit, now));
    return boundedIdentityTransaction(actions);
  }
  async commit(input: { proposalId: string; userIds: readonly string[] }): Promise<ConsolidationView> {
    this.actor(input.userIds); const stored = await this.proposal(input.proposalId), p = stored.value;
    if (!input.userIds.includes(p.actorId)) fail("consolidation_forbidden", "Only the organiser who prepared this proposal can combine it.", 403);
    await this.authority(p.leagueId, input.userIds, p.issuerId);
    if (p.state === "committed") return this.view(p, input.userIds, true);
    this.requireEnabled();
    if (p.state !== "ready") fail("proposal_approval_required", "The player must approve this proposal before it can be combined.");
    const context = await this.current(p);
    const actions = await this.commitPlan(context, stored);
    if (Date.parse(p.expiresAt) <= Date.parse(this.now())) fail("proposal_expired", "This proposal has expired. Prepare a new proposal.");
    try { await this.client.send(new TransactWriteItemsCommand({ TransactItems: actions })); }
    catch (error) {
      if (!cancelled(error)) throw error;
      const latest = await this.proposal(p.proposalId);
      if (latest.value.state === "committed" && latest.value.digest === p.digest) return this.view(latest.value, input.userIds, true);
      fail("proposal_stale", "The player profiles changed. Prepare a new proposal.");
    }
    return this.view({ ...p, state: "committed" }, input.userIds, true);
  }
}
