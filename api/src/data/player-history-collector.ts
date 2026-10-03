import { GetItemCommand, QueryCommand, TransactWriteItemsCommand,
  type GetItemCommandOutput, type QueryCommandOutput, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import { z } from 'zod';
import { PlayerIdentityPlanner } from './player-identity.js';
import { HistorySource, assembleMatchFacts, type HistoryGamePart } from './player-history-source.js';
import { historyBody, historyHash, historyKey, historyPartition, historyRow, PlayerHistoryError,
  type HistoryClient, type HistoryContext, type HistoryItem } from './player-history-model.js';
import type { HistoryCollector } from './player-history-store.js';

const MAX_ROWS = 10_000, MAX_BYTES = 8 * 1024 * 1024;
const RESOLVE_ROWS = 25, COLD_IDENTITIES = 4;
const parts: HistoryGamePart[] = ['roster', 'goals', 'audits', 'teams'];
const text = z.string().min(1).refine(value => value.trim().length > 0);
const unavailable = (message: string): never => { throw new PlayerHistoryError('history_unavailable', message); };
const changed = (): never => { throw new PlayerHistoryError('history_changed', 'History changed during collection.'); };
const invalidCursor = (): never => { throw new PlayerHistoryError('invalid_cursor', 'Invalid collection continuation.'); };
const pad = (value: number) => String(value).padStart(16, '0');
type Result = Awaited<ReturnType<HistoryCollector>>;
interface State {
  phase: 'reference' | 'parts' | 'resolve' | 'emit';
  refCursor: string | null; game: HistoryItem | null; gameIndex: number;
  part: number; partCursor: string | null; rows: number; bytes: number; canonicalBytes: number; resolved: number;
}
interface Receipt { binding: string; step: number; result: Result; next: State | null }
interface RawRecord { part: HistoryGamePart; item: HistoryItem }
interface ResolvedRecord extends RawRecord { canonical: Array<[string, string]> }
interface CanonicalCache { originalId: string; canonicalId: string }
const initial = (): State => ({ phase: 'reference', refCursor: null, game: null, gameIndex: 0,
  part: 0, partCursor: null, rows: 0, bytes: 0, canonicalBytes: 0, resolved: 0 });

/** Trusted worker callback. A receipt and its immutable source rows commit together.
 * Replaying a cursor reads that exact receipt rather than repeating a live page read.
 * Each step fetches one reference, one source page (25 rows), or resolves up to
 * 25 rows with at most four uncached identities of at most twenty members each.
 * Canonical mappings are cached within this member/generation/context, across
 * matches, and commit with their resolved rows and receipt. Final assembly has an
 * explicit 10,000-row / 8 MiB ceiling (including canonical mappings) and at most
 * 128 staged-page queries, allowing both DynamoDB's item-count and byte pages.
 */
export class ResumableHistoryCollector {
  private readonly source: HistorySource;
  private readonly identities: PlayerIdentityPlanner;
  constructor(private readonly client: HistoryClient, private readonly tableName: string, private readonly generation: string) {
    text.parse(generation); text.parse(tableName);
    this.source = new HistorySource(client, tableName);
    this.identities = new PlayerIdentityPlanner(client, tableName);
  }

  private async get(pk: string, sk: string): Promise<HistoryItem | null> {
    return ((await this.client.send(new GetItemCommand({ TableName: this.tableName, Key: historyKey(pk, sk),
      ConsistentRead: true }))) as GetItemCommandOutput).Item ?? null;
  }
  private readReceipt(item: HistoryItem, pk: string, sk: string, binding: string, step: number): Receipt {
    const value = historyBody<Receipt>(item, pk, sk, 'playerHistoryCollectionReceipt');
    if (!value || value.binding !== binding || value.step !== step || !value.result || !Array.isArray(value.result.matches)
      || value.result.matches.length > 1 || (value.result.cursor !== null && typeof value.result.cursor !== 'string'))
      unavailable('Malformed collection receipt.');
    if ((value.next === null) !== (value.result.cursor === null)) unavailable('Incomplete collection receipt.');
    return value;
  }
  private validateState(state: State): void {
    if (!state || !['reference', 'parts', 'resolve', 'emit'].includes(state.phase)
      || ![state.gameIndex, state.part, state.rows, state.bytes, state.canonicalBytes, state.resolved].every(value => Number.isSafeInteger(value) && value >= 0)
      || state.rows > MAX_ROWS || state.bytes + state.canonicalBytes > MAX_BYTES || state.resolved > state.rows || state.part > parts.length
      || [state.refCursor, state.partCursor].some(cursor => cursor !== null && (typeof cursor !== 'string' || cursor.length > 8192))
      || (state.phase !== 'reference' && !state.game)) unavailable('Malformed collection checkpoint.');
  }
  private cursor(binding: string, step: number): string {
    return Buffer.from(JSON.stringify({ version: 1, binding, step })).toString('base64url');
  }

  readonly readPage: HistoryCollector = async ({ context, memberId, cursor, limit }) => {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5 || !context.members.includes(memberId)
      || !context.checks.length || context.checks.length > 40 || context.checks.some(check =>
        !check.ConditionCheck || check.ConditionCheck.TableName !== this.tableName || check.Put || check.Update || check.Delete))
      unavailable('Invalid trusted collection context.');
    const binding = historyHash(this.generation, context.leagueId, context.playerId, memberId, context.sourceRevision,
      context.identityWriteVersion, context.identityEpoch, context.readinessRevision ?? '', String(context.ruleVersion ?? ''), JSON.stringify(context.members));
    const pk = historyPartition(context.leagueId, context.playerId);
    const base = `GEN#${historyHash(this.generation)}#COLLECT#${historyHash(memberId, binding)}#`;
    let step = 0;
    if (cursor !== null) {
      if (typeof cursor !== 'string' || cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalidCursor();
      try {
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
        if (value.version !== 1 || value.binding !== binding || !Number.isSafeInteger(value.step) || value.step < 1
          || value.step >= Number.MAX_SAFE_INTEGER || Object.keys(value).length !== 3) invalidCursor();
        step = value.step;
      } catch { invalidCursor(); }
    }
    const receiptSk = `${base}RECEIPT#${pad(step)}`;
    const replay = await this.get(pk, receiptSk);
    if (replay) return this.readReceipt(replay, pk, receiptSk, binding, step).result;
    let state = initial();
    if (step > 0) {
      const priorSk = `${base}RECEIPT#${pad(step - 1)}`, prior = await this.get(pk, priorSk);
      if (!prior) invalidCursor();
      const receipt = this.readReceipt(prior!, pk, priorSk, binding, step - 1);
      if (!receipt.next || receipt.result.cursor !== cursor) invalidCursor();
      state = receipt.next!;
    }
    this.validateState(state);
    let next: State | null = { ...state };
    const matches: Result['matches'] = [], rows: HistoryItem[] = [];
    const gameBase = `${base}GAME#${pad(state.gameIndex)}#`;
    const finishReference = () => { next = state.refCursor === null ? null : { ...initial(), refCursor: state.refCursor, gameIndex: step + 1 }; };
    if (state.phase === 'reference') {
      const page = await this.source.memberGamesPage(context, memberId, state.refCursor ?? undefined, 1);
      next.refCursor = page.cursor;
      if (!page.items.length) next = page.cursor === null ? null : { ...initial(), refCursor: page.cursor, gameIndex: step + 1 };
      else {
        const disposition = await this.source.disposition(page.items[0]);
        if (disposition.kind === 'skip') next = page.cursor === null ? null : { ...initial(), refCursor: page.cursor, gameIndex: step + 1 };
        else {
          next.game = disposition.game; next.bytes = Buffer.byteLength(JSON.stringify(disposition.game)); next.phase = 'parts';
          if (next.bytes > MAX_BYTES) unavailable('Game source exceeds assembly byte budget.');
        }
      }
    } else if (state.phase === 'parts') {
      if (state.part >= parts.length) unavailable('Source part checkpoint is invalid.');
      const gameId = historyBody<{ gameId: string }>(state.game!, state.game!.pk!.S!, 'METADATA', 'game').gameId;
      const part = parts[state.part], page = await this.source.gamePartitionPage(gameId, part, state.partCursor ?? undefined, 25);
      for (const item of page.items) {
        next.rows++; next.bytes += Buffer.byteLength(JSON.stringify(item));
        if (next.rows > MAX_ROWS || next.bytes > MAX_BYTES) unavailable('Game source exceeds assembly budget.');
        rows.push(historyRow(pk, `${gameBase}RAW#${pad(next.rows - 1)}`, 'playerHistoryCollectionRaw', { part, item } satisfies RawRecord));
      }
      next.partCursor = page.cursor;
      if (page.cursor === null) { next.part++; if (next.part === parts.length) next.phase = 'resolve'; }
    } else if (state.phase === 'resolve') {
      if (state.part !== parts.length || state.partCursor !== null) unavailable('Source partitions are incomplete.');
      if (state.resolved === state.rows) next.phase = 'emit';
      else {
        const prefix = `${gameBase}RAW#`;
        const page = await this.client.send(new QueryCommand({ TableName: this.tableName, ConsistentRead: true, Limit: RESOLVE_ROWS,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':pk': { S: pk }, ':prefix': { S: prefix } },
          ...(state.resolved ? { ExclusiveStartKey: historyKey(pk, `${prefix}${pad(state.resolved - 1)}`) } : {}),
        })) as QueryCommandOutput;
        const staged = page.Items ?? [], continuation = page.LastEvaluatedKey;
        if (!staged.length || staged.length > RESOLVE_ROWS || state.resolved + staged.length > state.rows)
          unavailable('Invalid staged source page.');
        // DynamoDB can stop at its byte limit before Limit. A nonterminal page
        // must identify the actual last row; the next delivery resumes by index.
        const hasMore = continuation && Object.keys(continuation).length > 0;
        if (hasMore ? continuation.pk?.S !== pk || continuation.sk?.S !== `${prefix}${pad(state.resolved + staged.length - 1)}`
          : state.resolved + staged.length !== state.rows) unavailable('Incomplete staged source page.');
        const rawRows = staged.map((item, offset) => {
          const raw = historyBody<RawRecord>(item, pk, `${prefix}${pad(state.resolved + offset)}`, 'playerHistoryCollectionRaw');
          if (!parts.includes(raw.part) || !raw.item?.data?.S) unavailable('Malformed staged source row.');
          return raw;
        });
        const cache = new Map<string, string | null>();
        let cold = 0;
        for (const raw of rawRows) {
          const data = JSON.parse(raw.item.data!.S!) as Record<string, unknown>;
          const ids = [...new Set(raw.part === 'roster' ? [text.parse(data.playerId)] : raw.part === 'goals'
            ? [text.parse(data.scorerPlayerId), ...z.array(text).max(3).parse(data.assistPlayerIds)] : [])];
          for (const id of ids) if (!cache.has(id)) {
            const cacheSk = `${base}CANONICAL#${historyHash(id)}`, cached = await this.get(pk, cacheSk);
            if (!cached) cache.set(id, null);
            else {
              const mapping = historyBody<CanonicalCache>(cached, pk, cacheSk, 'playerHistoryCollectionCanonical');
              if (mapping.originalId !== id) unavailable('Malformed canonical cache.');
              cache.set(id, text.parse(mapping.canonicalId));
            }
          }
          const missing = ids.filter(id => cache.get(id) === null);
          // A row has at most four identities, so even a completely cold page
          // always advances at least one row. Never stage half a row's credits.
          if (cold + missing.length > COLD_IDENTITIES) break;
          for (const id of missing) {
            const identity = await this.identities.resolve(id), canonicalId = identity.root.value.playerId;
            cache.set(id, canonicalId); cold++;
            rows.push(historyRow(pk, `${base}CANONICAL#${historyHash(id)}`, 'playerHistoryCollectionCanonical',
              { originalId: id, canonicalId } satisfies CanonicalCache));
          }
          const canonical: Array<[string, string]> = ids.map(id => [id, cache.get(id)!]);
          next.canonicalBytes += Buffer.byteLength(JSON.stringify(canonical));
          if (next.bytes + next.canonicalBytes > MAX_BYTES) unavailable('Canonical game source exceeds assembly budget.');
          rows.push(historyRow(pk, `${gameBase}RESOLVED#${pad(next.resolved)}`, 'playerHistoryCollectionResolved', { ...raw, canonical } satisfies ResolvedRecord));
          next.resolved++;
        }
        if (next.resolved === next.rows) next.phase = 'emit';
      }
    } else {
      if (state.part !== parts.length || state.partCursor !== null || state.resolved !== state.rows)
        unavailable('Source collection is incomplete.');
      const complete = await this.assemble(pk, gameBase, state, context);
      if (complete) matches.push(complete);
      finishReference();
    }
    const result: Result = { matches, cursor: next ? this.cursor(binding, step + 1) : null };
    const receipt: Receipt = { binding, step, result, next };
    rows.push(historyRow(pk, receiptSk, 'playerHistoryCollectionReceipt', receipt));
    const actions: TransactWriteItem[] = [...context.checks, ...rows.map(Item => ({ Put: {
      TableName: this.tableName, Item, ConditionExpression: 'attribute_not_exists(pk)',
    } }))];
    // Resolve commits at most 40 fences + 25 rows + 4 cache entries + 1 receipt.
    if (actions.length > 100 || Buffer.byteLength(JSON.stringify(actions)) > 3_500_000)
      unavailable('Collection checkpoint exceeds transaction budget.');
    try { await this.client.send(new TransactWriteItemsCommand({ TransactItems: actions })); }
    catch (error) {
      const failure = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
      if (failure.name === 'ConditionalCheckFailedException' || (failure.name === 'TransactionCanceledException'
        && failure.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed'))) {
        const won = await this.get(pk, receiptSk);
        if (won) return this.readReceipt(won, pk, receiptSk, binding, step).result;
        changed();
      }
      throw error;
    }
    return result;
  };

  private async assemble(pk: string, gameBase: string, state: State, context: HistoryContext) {
    const staged: Record<HistoryGamePart, HistoryItem[]> = { roster: [], goals: [], audits: [], teams: [] };
    const canonicalIds = new Map<string, string>(), prefix = `${gameBase}RESOLVED#`;
    let after: string | undefined, count = 0, bytes = Buffer.byteLength(JSON.stringify(state.game)), canonicalBytes = 0;
    for (let pageNumber = 0; pageNumber < 128; pageNumber++) {
      const page = await this.client.send(new QueryCommand({ TableName: this.tableName, ConsistentRead: true, Limit: 100,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': { S: pk }, ':prefix': { S: prefix } },
        ...(after ? { ExclusiveStartKey: historyKey(pk, after) } : {}) })) as QueryCommandOutput;
      if ((page.Items?.length ?? 0) > 100) unavailable('Invalid staged source page.');
      for (const row of page.Items ?? []) {
        const sk = `${prefix}${pad(count)}`;
        const value = historyBody<ResolvedRecord>(row, pk, sk, 'playerHistoryCollectionResolved');
        if (!Object.hasOwn(staged, value.part) || !Array.isArray(value.canonical) || value.canonical.length > 4)
          unavailable('Malformed resolved source row.');
        count++; bytes += Buffer.byteLength(JSON.stringify(value.item));
        canonicalBytes += Buffer.byteLength(JSON.stringify(value.canonical));
        if (count > state.rows || count > MAX_ROWS || bytes + canonicalBytes > MAX_BYTES) unavailable('Game assembly exceeds its budget.');
        staged[value.part].push(value.item);
        for (const [id, root] of value.canonical) {
          text.parse(id); text.parse(root);
          if (canonicalIds.has(id) && canonicalIds.get(id) !== root) changed();
          canonicalIds.set(id, root);
        }
        after = sk;
      }
      const key = page.LastEvaluatedKey;
      if (!key || !Object.keys(key).length) {
        if (count !== state.rows || bytes !== state.bytes || canonicalBytes !== state.canonicalBytes) unavailable('Staged source coverage mismatch.');
        return assembleMatchFacts({ context, game: state.game!, ...staged, canonicalIds });
      }
      if (!page.Items?.length || key.pk?.S !== pk || key.sk?.S !== after) unavailable('Non-progressing staged source page.');
    }
    unavailable('Game source requires too many assembly pages.');
  }
}
