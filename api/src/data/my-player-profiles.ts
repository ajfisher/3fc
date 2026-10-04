import { GetItemCommand, QueryCommand, type QueryCommandOutput } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { playerClaimSk } from './keys.js';
import { PlayerIdentityPlanner, PlayerIdentityError, identityCondition, identityLeagueSk, validPlayerIdentityId, type IdentityClient, type IdentitySnapshot } from './player-identity.js';
import { readPlayerClaimsRevision } from './player-claims-revision.js';
import { PlayerProfileAccess } from './player-profile-access.js';
import { historyBody, historyHash, historyKey, type HistoryItem } from './player-history-model.js';

export interface MyPlayerProfilesPage {
  profiles: Array<{ playerId: string; displayName: string; leagueId: string; leagueName: string }>;
  cursor: string | null;
  complete: boolean;
}
type Data = Record<string, unknown>;
const fail = (): never => { throw new PlayerIdentityError('player_profile_unavailable', 503, 'Your player profiles could not be checked. Try again.'); };
const invalid = (): never => { throw new PlayerIdentityError('invalid_player_cursor', 400, 'Start a new player search.'); };
const cursorSchema = z.object({ version: z.literal(1), binding: z.string(), account: z.number().int().min(0).max(1),
  namespace: z.enum(['PLAYER#', 'PLAYER_HASH#']), after: z.string().nullable(),
  pending: z.object({ playerId: z.string(), claimKey: z.string(), leagueAfter: z.string() }).strict().nullable() }).strict();

/** Discover only the caller's profiles using existing claim and reverse league
 * indexes. Each page visits one claim and at most five league memberships. */
export class MyPlayerProfiles {
  constructor(private readonly client: IdentityClient, private readonly tableName: string) {}
  private async read(pk: string, sk: string, type: string): Promise<IdentitySnapshot<Data>> {
    if (Buffer.byteLength(pk) > 2048 || Buffer.byteLength(sk) > 1024) return fail();
    const item = (await this.client.send(new GetItemCommand({ TableName: this.tableName, Key: historyKey(pk, sk), ConsistentRead: true })) as { Item?: HistoryItem }).Item ?? null;
    return { pk, sk, item, value: item ? historyBody<Data>(item, pk, sk, type) : {} };
  }
  private async page(pk: string, prefix: string, after: string | null, limit: number) {
    const result = await this.client.send(new QueryCommand({ TableName: this.tableName, ConsistentRead: true, Limit: limit,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)', ExpressionAttributeValues: { ':pk': { S: pk }, ':prefix': { S: prefix } },
      ...(after ? { ExclusiveStartKey: historyKey(pk, after) } : {}) })) as QueryCommandOutput;
    const rows = result.Items ?? [], next = result.LastEvaluatedKey;
    if (rows.length > limit) return fail();
    for (const row of rows) if (row.pk?.S !== pk || !row.sk?.S?.startsWith(prefix) || (after && Buffer.compare(Buffer.from(row.sk.S), Buffer.from(after)) <= 0)) return fail();
    const last = next && Object.keys(next).length ? next.sk?.S : null;
    if (last && (next?.pk?.S !== pk || !last.startsWith(prefix) || Buffer.byteLength(last) > 1024 || after && Buffer.compare(Buffer.from(last), Buffer.from(after)) <= 0)) return fail();
    if (next && Object.keys(next).length && !last) return fail();
    return { rows, last };
  }
  async list(input: { userId: string; userIds?: readonly string[]; cursor?: string }): Promise<MyPlayerProfilesPage> {
    const accounts = [...new Set([input.userId, ...(input.userIds ?? [])])];
    if (accounts.length > 2 || accounts.some(value => !value.trim() || Buffer.byteLength(`USER#${value}`) > 2048)) return fail();
    const deadline = Date.now() + 8000, planner = new PlayerIdentityPlanner(this.client, this.tableName);
    const control = await planner.readControl(); planner.requireDirectory(control);
    const revisions = await Promise.all(accounts.map(account => readPlayerClaimsRevision(this.client, this.tableName, account)));
    const binding = historyHash(JSON.stringify(accounts), control.value.epoch, JSON.stringify(revisions.map(row => row.value.revision)));
    let state: z.infer<typeof cursorSchema> = { version: 1, binding, account: 0, namespace: 'PLAYER#', after: null, pending: null };
    if (input.cursor !== undefined) {
      try {
        if (!input.cursor || input.cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) return invalid();
        state = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')));
        if (state.binding !== binding || state.account >= accounts.length || state.after !== null && (!state.after.startsWith(state.namespace) || Buffer.byteLength(state.after) > 1024)
          || state.pending && (!validPlayerIdentityId(state.pending.playerId) || state.pending.claimKey !== playerClaimSk(state.pending.playerId)
            || !state.pending.claimKey.startsWith(state.namespace) || !/^LEAGUE#[a-f0-9]{64}$/.test(state.pending.leagueAfter))) return invalid();
      } catch (error) { if (error instanceof PlayerIdentityError) throw error; return invalid(); }
    }
    const checks = [identityCondition(this.tableName, control), ...revisions.map(row => identityCondition(this.tableName, row))];
    const profiles: MyPlayerProfilesPage['profiles'] = [];
    const pk = `USER#${accounts[state.account]}`;
    let claimId: string | null = state.pending?.playerId ?? null, claimKey = state.pending?.claimKey ?? null;
    let continuedEmptyClaims = false;
    if (!claimId) {
      const page = await this.page(pk, state.namespace, state.after, 1), row = page.rows[0];
      if (row) {
        const claim = historyBody<Data>(row, pk, row.sk!.S!, 'playerClaim');
        if (claim.userId !== accounts[state.account] || !validPlayerIdentityId(claim.playerId) || row.sk!.S !== playerClaimSk(claim.playerId)) return fail();
        claimId = claim.playerId; claimKey = row.sk!.S!;
      } else if (page.last) {
        state.after = page.last; continuedEmptyClaims = true;
      }
    }
    if (claimId && claimKey) {
      const claim = await this.read(pk, claimKey, 'playerClaim');
      if (!claim.item || claim.value.playerId !== claimId || claim.value.userId !== accounts[state.account]) return fail();
      checks.push(identityCondition(this.tableName, claim));
      const identity = await planner.resolve(claimId), root = identity.root.value.playerId;
      const profile = await this.read(`PLAYER#${root}`, 'PROFILE', 'player');
      checks.push(identityCondition(this.tableName, identity.root), identityCondition(this.tableName, profile));
      if (!profile.item || profile.value.playerId !== root) return fail();
      if (accounts.includes(profile.value.claimedByUserId as string)) {
        // A single stable representative prevents aliases and the two account
        // namespaces from listing the same canonical profile more than once.
        const ids = [root, ...identity.root.value.members.filter(id => id !== root).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)))];
        const candidates = ids.flatMap(id => accounts.map(account => ({ id, account })));
        let representative: { id: string; account: string } | undefined;
        for (const candidate of candidates) {
          const row = await this.read(`USER#${candidate.account}`, playerClaimSk(candidate.id), 'playerClaim');
          if (!row.item) continue;
          if (row.value.userId !== candidate.account || row.value.playerId !== candidate.id) return fail();
          representative = candidate; break;
        }
        if (representative?.id === claimId && representative.account === accounts[state.account]) {
          const leagues = await this.page(`PLAYER#${root}`, 'LEAGUE#', state.pending?.leagueAfter ?? null, 5);
          const access = new PlayerProfileAccess(this.client, this.tableName);
          for (const row of leagues.rows) {
            const membership = historyBody<Data>(row, `PLAYER#${root}`, row.sk!.S!, 'playerLeagueMembership');
            if (membership.playerId !== root || typeof membership.leagueId !== 'string' || row.sk!.S !== identityLeagueSk(membership.leagueId)) return fail();
            if (Date.now() >= deadline) return fail();
            try {
              const result = await access.authorize({ playerId: root, leagueId: membership.leagueId, userId: input.userId, userIds: accounts });
              if (result.owner) profiles.push({ playerId: root, displayName: result.player.displayName, leagueId: result.league.leagueId, leagueName: result.league.name });
            } catch (error) { if (!(error instanceof PlayerIdentityError && error.status === 403)) throw error; }
          }
          if (leagues.last) state.pending = { playerId: claimId, claimKey, leagueAfter: leagues.last };
          else state.pending = null;
        } else state.pending = null;
      } else state.pending = null;
      if (!state.pending) state.after = claimKey;
    } else if (!continuedEmptyClaims) {
      state.pending = null; state.after = null;
      if (state.namespace === 'PLAYER#') state.namespace = 'PLAYER_HASH#';
      else { state.account += 1; state.namespace = 'PLAYER#'; }
    }
    if (Date.now() >= deadline) return fail();
    await new PlayerProfileAccess(this.client, this.tableName).assertCurrent(checks);
    const complete = state.account >= accounts.length;
    return { profiles, cursor: complete ? null : Buffer.from(JSON.stringify(state)).toString('base64url'), complete };
  }
}
