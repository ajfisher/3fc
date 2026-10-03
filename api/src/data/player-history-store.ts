import { GetItemCommand, QueryCommand, TransactWriteItemsCommand,
  type GetItemCommandOutput, type QueryCommandOutput, type TransactWriteItem } from '@aws-sdk/client-dynamodb';
import type { AchievementScopeContext, PlayerAppearance } from '@3fc/contracts';
import { applyAppearance, emptyAccumulator, type AchievementAccumulator, type MatchFacts } from '../achievements/evaluate.js';
import { matchFactsSchema, matchOrderKey } from '../achievements/facts.js';
import { PlayerHistoryError, historyBody, historyHash, historyKey, historyPartition, historyRow,
  type HistoryAward, type HistoryClient, type HistoryContext, type HistoryGeneration, type HistoryItem,
  type HistoryPage, type HistoryPublication, type HistorySummary } from './player-history-model.js';

/** This callback is constructed by the worker from the authoritative source adapter.
 * It is never an HTTP/queue payload or a caller-provided completion attestation. */
export type HistoryCollector = (input: { context: HistoryContext; memberId: string; cursor: string | null; limit: number }) =>
  Promise<{ matches: MatchFacts[]; cursor: string | null }>;
export type HistoryPhase = 'collecting' | 'evaluating' | 'complete' | 'published';
interface GenerationRecord {
  spec: HistoryGeneration;
  previousPublication: string | null;
  phase: HistoryPhase;
  version: number;
  member: number;
  sourceCursor: string | null;
  collected: number;
  evaluated: number;
  evaluationCursor: string | null;
  evaluationDone: boolean;
  summaryKeys: Record<string, string>;
  latest: PlayerAppearance | null;
  seasons: Array<{ seasonId: string; lastPlayedAt: string }>;
}
interface Snapshot { pk: string; sk: string; item: HistoryItem; value: GenerationRecord }
interface FactRecord { facts: MatchFacts; collectionVersion: number }
export interface HistoryStep { phase: HistoryPhase; collected: number; evaluated: number; evaluationDone: boolean; done: boolean }
interface Cursor { version: 1; pk: string; generation: string; prefix: string; last: string }
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const unavailable = (message: string): never => { throw new PlayerHistoryError('history_unavailable', message); };
const changed = (): never => { throw new PlayerHistoryError('history_changed', 'History changed; restart from its current checkpoint.'); };
const invalidCursor = (): never => { throw new PlayerHistoryError('invalid_cursor', 'History continuation is invalid or stale.'); };
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
  if (item && typeof item === 'object' && !Array.isArray(item)) return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  return item;
});
const scopeKey = (scope: AchievementScopeContext): string => scope.scope === 'career' ? 'CAREER' : `SEASON#${historyHash(scope.seasonId)}`;
const generationPrefix = (generation: string): string => `GEN#${historyHash(generation)}#`;
const step = (record: GenerationRecord): HistoryStep => ({ phase: record.phase, collected: record.collected,
  evaluated: record.evaluated, evaluationDone: record.evaluationDone, done: record.phase === 'complete' || record.phase === 'published' });

/** Internal storage boundary, not an authorisation boundary. Routes must authenticate league
 * access separately. Staging never changes the published generation; prior generations and
 * their award evidence remain immutable indefinitely (no TTL or deletion in this slice). */
export class PlayerHistoryStore {
  constructor(private readonly client: HistoryClient, private readonly tableName: string) {}

  private row(pk: string, sk: string, type: string, data: unknown): HistoryItem {
    const row = historyRow(pk, sk, type, data);
    row.data = { S: canonical(data) };
    return row;
  }
  private async read(pk: string, sk: string): Promise<HistoryItem | null> {
    return ((await this.client.send(new GetItemCommand({ TableName: this.tableName,
      Key: historyKey(pk, sk), ConsistentRead: true }))) as GetItemCommandOutput).Item ?? null;
  }
  private equals(item: HistoryItem): Pick<NonNullable<TransactWriteItem['ConditionCheck']>, 'ConditionExpression' | 'ExpressionAttributeNames' | 'ExpressionAttributeValues'> {
    return { ConditionExpression: '#data = :expected', ExpressionAttributeNames: { '#data': 'data' },
      ExpressionAttributeValues: { ':expected': item.data! } };
  }
  private guard(snapshot: Snapshot): TransactWriteItem {
    return { ConditionCheck: { TableName: this.tableName, Key: historyKey(snapshot.pk, snapshot.sk), ...this.equals(snapshot.item) } };
  }
  private async transact(actions: TransactWriteItem[]): Promise<void> {
    if (actions.length > 100 || Buffer.byteLength(JSON.stringify(actions)) > 3_500_000) unavailable('History transaction exceeds its bounded budget.');
    const keys = actions.map(action => { const op = action.Put ?? action.Update ?? action.Delete ?? action.ConditionCheck;
      if (!op || op.TableName !== this.tableName) return unavailable('Invalid history transaction.');
      const key = action.Put?.Item ?? ('Key' in op ? op.Key : undefined);
      return canonical([key?.pk, key?.sk]); });
    if (new Set(keys).size !== keys.length) unavailable('Conflicting history transaction actions.');
    try { await this.client.send(new TransactWriteItemsCommand({ TransactItems: actions })); }
    catch (error) {
      const failure = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
      if (failure.name === 'ConditionalCheckFailedException' || (failure.name === 'TransactionCanceledException' &&
        failure.CancellationReasons?.some(reason => reason.Code === 'ConditionalCheckFailed'))) changed();
      throw error;
    }
  }
  private validateSpec(spec: HistoryGeneration): void {
    const context = spec.context;
    if (!text(spec.generation) || !text(spec.calculatedAt) || !Number.isFinite(Date.parse(spec.calculatedAt)) ||
      !context || ![context.playerId, context.leagueId, context.sourceRevision, context.identityWriteVersion, context.identityEpoch].every(text) ||
      !Array.isArray(context.members) || context.members.length < 1 || context.members.length > 20 ||
      !context.members.every(text) || !context.members.includes(context.playerId) || new Set(context.members).size !== context.members.length ||
      !Array.isArray(context.checks) || context.checks.length < 1 || context.checks.length > 40 ||
      context.checks.some(check => !check.ConditionCheck || check.ConditionCheck.TableName !== this.tableName || check.Put || check.Update || check.Delete))
      unavailable('Invalid trusted history generation context.');
  }
  private async snapshot(spec: HistoryGeneration): Promise<Snapshot> {
    this.validateSpec(spec);
    const pk = historyPartition(spec.context.leagueId, spec.context.playerId), sk = `${generationPrefix(spec.generation)}META`;
    const item = await this.read(pk, sk);
    if (!item) unavailable('History generation does not exist.');
    const value = historyBody<GenerationRecord>(item!, pk, sk, 'playerHistoryGeneration');
    if (!value || canonical(value.spec) !== canonical(spec) ||
      ![value.version, value.member, value.collected, value.evaluated].every(number => Number.isSafeInteger(number) && number >= 0 && number < Number.MAX_SAFE_INTEGER) ||
      !Array.isArray(value.seasons) || value.seasons.length > 256 || !value.summaryKeys || Object.keys(value.summaryKeys).length > 257 ||
      !['collecting', 'evaluating', 'complete', 'published'].includes(value.phase)) unavailable('Malformed history generation.');
    return { pk, sk, item: item!, value };
  }
  private async advance(snapshot: Snapshot, value: GenerationRecord, other: TransactWriteItem[] = []): Promise<void> {
    await this.transact([...other, { Put: { TableName: this.tableName,
      Item: this.row(snapshot.pk, snapshot.sk, 'playerHistoryGeneration', { ...value, version: snapshot.value.version + 1 }),
      ...this.equals(snapshot.item) } }]);
  }
  /** Immutable writes tolerate exact retry only; even an unpublished row cannot be replaced. */
  private async stage(snapshot: Snapshot, rows: HistoryItem[]): Promise<void> {
    for (let offset = 0; offset < rows.length; offset += 5) {
      const chunk = rows.slice(offset, offset + 5);
      await this.transact([this.guard(snapshot), ...chunk.map(Item => ({ Put: { TableName: this.tableName, Item,
        ConditionExpression: 'attribute_not_exists(pk) OR #data = :same', ExpressionAttributeNames: { '#data': 'data' },
        ExpressionAttributeValues: { ':same': Item.data! } } }))]);
    }
  }
  async beginGeneration(spec: HistoryGeneration): Promise<HistoryStep> {
    this.validateSpec(spec);
    const pk = historyPartition(spec.context.leagueId, spec.context.playerId), sk = `${generationPrefix(spec.generation)}META`;
    const existing = await this.read(pk, sk);
    if (existing) return step((await this.snapshot(spec)).value);
    const prior = await this.read(pk, 'PUBLISHED');
    const value: GenerationRecord = { spec, previousPublication: prior?.data?.S ?? null, phase: 'collecting', version: 0,
      member: 0, sourceCursor: null, collected: 0, evaluated: 0, evaluationCursor: null, evaluationDone: false,
      summaryKeys: {}, latest: null, seasons: [] };
    await this.transact([...spec.context.checks, { Put: { TableName: this.tableName,
      Item: this.row(pk, sk, 'playerHistoryGeneration', value), ConditionExpression: 'attribute_not_exists(pk)' } }]);
    return step(value);
  }
  private async stageMatch(snapshot: Snapshot, facts: MatchFacts): Promise<void> {
    // A repeated game from a different member/page is contradictory canonical history.
    // The collection version makes that fail closed while allowing the same step's retry.
    const prefix = generationPrefix(snapshot.value.spec.generation), record: FactRecord = { facts, collectionVersion: snapshot.value.version };
    await this.stage(snapshot, [this.row(snapshot.pk, `${prefix}FACT#${matchOrderKey(facts)}`, 'playerHistoryFact', record),
      this.row(snapshot.pk, `${prefix}GAME#${historyHash(facts.gameId)}`, 'playerHistoryFactIdentity', record)]);
  }
  /** One authoritative member page per call; only this path advances collection coverage. */
  async collectNext(spec: HistoryGeneration, readPage: HistoryCollector): Promise<HistoryStep> {
    const snapshot = await this.snapshot(spec), current = snapshot.value;
    if (current.phase !== 'collecting') return step(current);
    const memberId = spec.context.members[current.member];
    if (!memberId) unavailable('Invalid member collection checkpoint.');
    const page = await readPage({ context: structuredClone(spec.context), memberId, cursor: current.sourceCursor, limit: 5 });
    if (!page || !Array.isArray(page.matches) || page.matches.length > 5 ||
      (page.cursor !== null && (!text(page.cursor) || page.cursor.length > 8192 || page.cursor === current.sourceCursor)))
      unavailable('Invalid authoritative history page.');
    const facts = page.matches.map(value => matchFactsSchema.parse(value));
    if (facts.some(value => value.leagueId !== spec.context.leagueId || value.sourceRevision !== spec.context.sourceRevision) || new Set(facts.map(value => value.gameId)).size !== facts.length)
      unavailable('History source page crosses scope or repeats a game.');
    for (const value of facts) await this.stageMatch(snapshot, value);
    const member = page.cursor === null ? current.member + 1 : current.member;
    const next: GenerationRecord = { ...current, member, sourceCursor: page.cursor, collected: current.collected + facts.length,
      phase: member === spec.context.members.length ? 'evaluating' : 'collecting' };
    if (next.phase === 'evaluating') {
      const key = `${generationPrefix(spec.generation)}STATE#0000000000000000#CAREER`;
      await this.stageSummary(snapshot, key, emptyAccumulator());
      next.summaryKeys.CAREER = key;
    }
    await this.advance(snapshot, next);
    return step(next);
  }
  private async query(pk: string, prefix: string, last: string | null, limit: number, forward: boolean): Promise<{ rows: HistoryItem[]; last: string | null }> {
    const response = await this.client.send(new QueryCommand({ TableName: this.tableName, ConsistentRead: true,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': { S: pk }, ':prefix': { S: prefix } }, Limit: limit,
      ScanIndexForward: forward, ...(last ? { ExclusiveStartKey: historyKey(pk, last) } : {}) })) as QueryCommandOutput;
    const rows = response.Items ?? [];
    if (!Array.isArray(rows) || rows.length > limit) unavailable('Malformed history page.');
    let prior = last;
    for (const row of rows) {
      const key = row.sk?.S;
      if (row.pk?.S !== pk || !key?.startsWith(prefix) || (prior && (forward ? key <= prior : key >= prior))) unavailable('Non-progressing history page.');
      prior = key!;
    }
    const next = response.LastEvaluatedKey && Object.keys(response.LastEvaluatedKey).length ? response.LastEvaluatedKey : null;
    if (next && (next.pk?.S !== pk || !next.sk?.S?.startsWith(prefix) || !rows.length || next.sk.S !== prior)) unavailable('Malformed history continuation.');
    return { rows, last: next?.sk?.S ?? null };
  }
  private async state(snapshot: Snapshot, key: string): Promise<AchievementAccumulator> {
    if (!key.startsWith(`${generationPrefix(snapshot.value.spec.generation)}STATE#`)) unavailable('Invalid summary reference.');
    const item = await this.read(snapshot.pk, key);
    if (!item) unavailable('History summary is missing.');
    const value = historyBody<HistorySummary>(item!, snapshot.pk, key, 'playerHistorySummary');
    if (!value?.state || !value.state.totals || !value.state.counts) unavailable('Malformed history summary.');
    return value.state;
  }
  private async stageSummary(snapshot: Snapshot, key: string, state: AchievementAccumulator): Promise<void> {
    await this.stage(snapshot, [this.row(snapshot.pk, key, 'playerHistorySummary', { state })]);
  }
  private async stageAwards(snapshot: Snapshot, awards: HistoryAward[]): Promise<void> {
    const prefix = generationPrefix(snapshot.value.spec.generation);
    await this.stage(snapshot, awards.map(award => this.row(snapshot.pk,
      `${prefix}AWARD#${scopeKey(award)}#${award.earnedAt}#${award.id}`, 'playerHistoryAward', award)));
  }
  /** One immutable canonical fact per step. All staging is retry-safe; checkpoint publication
   * follows every award/summary write, so a failed chunk never advances evaluation coverage. */
  async evaluateNext(spec: HistoryGeneration): Promise<HistoryStep> {
    const snapshot = await this.snapshot(spec), current = snapshot.value;
    if (current.phase !== 'evaluating') {
      if (current.phase === 'collecting') unavailable('Collection coverage is not complete.');
      return step(current);
    }
    if (current.evaluationDone) return step(current);
    const prefix = generationPrefix(spec.generation);
    const page = await this.query(snapshot.pk, `${prefix}FACT#`, current.evaluationCursor, 1, true);
    if (!page.rows.length) {
      if (current.collected !== current.evaluated) unavailable('History evaluation coverage mismatch.');
      const next = { ...current, evaluationDone: true };
      await this.advance(snapshot, next);
      return step(next);
    }
    const row = page.rows[0], fact = historyBody<FactRecord>(row, snapshot.pk, row.sk!.S!, 'playerHistoryFact');
    const facts = matchFactsSchema.parse(fact.facts);
    if (row.sk!.S !== `${prefix}FACT#${matchOrderKey(facts)}` || facts.leagueId !== spec.context.leagueId ||
      facts.sourceRevision !== spec.context.sourceRevision) unavailable('Malformed staged fact.');
    const career = await this.state(snapshot, current.summaryKeys.CAREER);
    const seasonScope: AchievementScopeContext = { scope: 'season', seasonId: facts.seasonId }, season = scopeKey(seasonScope);
    const priorSeason = current.summaryKeys[season] ? await this.state(snapshot, current.summaryKeys[season]) : emptyAccumulator();
    const careerResult = applyAppearance(career, facts, spec.context.playerId, 'career');
    const seasonResult = applyAppearance(priorSeason, facts, spec.context.playerId, 'season');
    const ordinal = String(current.evaluated + 1).padStart(16, '0');
    const careerKey = `${prefix}STATE#${ordinal}#CAREER`, seasonKey = `${prefix}STATE#${ordinal}#${season}`;
    await this.stageAwards(snapshot, [...careerResult.unlocks, ...seasonResult.unlocks].map(award => ({ ...award, calculatedAt: spec.calculatedAt })));
    await this.stageSummary(snapshot, careerKey, careerResult.state);
    await this.stageSummary(snapshot, seasonKey, seasonResult.state);
    const appearance = careerResult.appearance;
    if (appearance) await this.stage(snapshot, [
      this.row(snapshot.pk, `${prefix}MATCH#${matchOrderKey(facts)}`, 'playerHistoryAppearance', appearance),
      this.row(snapshot.pk, `${prefix}${season}#MATCH#${matchOrderKey(facts)}`, 'playerHistoryAppearance', appearance)
    ]);
    const seasons = [...current.seasons];
    if (appearance) {
      const index = seasons.findIndex(value => value.seasonId === facts.seasonId);
      const value = { seasonId: facts.seasonId, lastPlayedAt: facts.kickoffAt };
      if (index < 0) seasons.push(value); else seasons[index] = value;
    }
    if (seasons.length > 256 || Object.keys(current.summaryKeys).length + (current.summaryKeys[season] ? 0 : 1) > 257)
      unavailable('History has too many seasons for this bounded generation.');
    const next: GenerationRecord = { ...current, evaluated: current.evaluated + 1, evaluationCursor: row.sk!.S!,
      summaryKeys: { ...current.summaryKeys, CAREER: careerKey, [season]: seasonKey },
      latest: appearance ?? current.latest, seasons };
    await this.advance(snapshot, next);
    return step(next);
  }
  async markComplete(spec: HistoryGeneration): Promise<HistoryStep> {
    const snapshot = await this.snapshot(spec), current = snapshot.value;
    if (current.phase === 'complete' || current.phase === 'published') return step(current);
    if (current.phase !== 'evaluating' || !current.evaluationDone || current.member !== spec.context.members.length ||
      current.sourceCursor !== null || current.collected !== current.evaluated || !current.summaryKeys.CAREER)
      unavailable('Trusted collection and evaluation checkpoints are not exhausted.');
    for (const key of Object.values(current.summaryKeys)) await this.state(snapshot, key);
    const next: GenerationRecord = { ...current, phase: 'complete' };
    await this.advance(snapshot, next);
    return step(next);
  }
  async publish(spec: HistoryGeneration): Promise<HistoryPublication> {
    const snapshot = await this.snapshot(spec), current = snapshot.value;
    if (current.phase === 'published') {
      const active = await this.getPublication(spec.context.leagueId, spec.context.playerId);
      if (active?.generation !== spec.generation) changed();
      return active!;
    }
    if (current.phase !== 'complete') unavailable('History generation coverage is not complete.');
    const previous = current.previousPublication ? JSON.parse(current.previousPublication) as HistoryPublication : null;
    const publication: HistoryPublication = { generation: spec.generation, leagueId: spec.context.leagueId, playerId: spec.context.playerId,
      sourceRevision: spec.context.sourceRevision, readinessRevision: spec.context.readinessRevision, ruleVersion: spec.context.ruleVersion, identityWriteVersion: spec.context.identityWriteVersion, identityEpoch: spec.context.identityEpoch,
      calculatedAt: spec.calculatedAt, latest: current.latest, seasons: current.seasons,
      previousGeneration: previous?.generation ?? null };
    const Item = this.row(snapshot.pk, 'PUBLISHED', 'playerHistoryPublication', publication);
    await this.advance(snapshot, { ...current, phase: 'published' }, [...spec.context.checks,
      { Put: { TableName: this.tableName, Item,
        ...(current.previousPublication === null ? { ConditionExpression: 'attribute_not_exists(pk)' } : {
          ConditionExpression: '#data = :expected', ExpressionAttributeNames: { '#data': 'data' },
          ExpressionAttributeValues: { ':expected': { S: current.previousPublication } } }) } },
      { Put: { TableName: this.tableName, Item: this.row(snapshot.pk, `PUBLICATION#${historyHash(spec.generation)}`, 'playerHistoryPublicationAudit', publication),
        ConditionExpression: 'attribute_not_exists(pk)' } }
    ]);
    return publication;
  }
  /** Operator comparison only: never exposed as a live profile before publish. */
  async previewCareer(spec: HistoryGeneration): Promise<HistorySummary> {
    const snapshot = await this.snapshot(spec);
    if (!['complete', 'published'].includes(snapshot.value.phase)) unavailable('Comparison history is incomplete.');
    return { state: await this.state(snapshot, snapshot.value.summaryKeys.CAREER) };
  }
  async getPublication(leagueId: string, playerId: string): Promise<HistoryPublication | null> {
    const pk = historyPartition(leagueId, playerId), item = await this.read(pk, 'PUBLISHED');
    if (!item) return null;
    const result = historyBody<HistoryPublication>(item, pk, 'PUBLISHED', 'playerHistoryPublication');
    if (!result || result.leagueId !== leagueId || result.playerId !== playerId || !text(result.generation) || !text(result.sourceRevision)) unavailable('Malformed history publication.');
    return result;
  }
  private async publishedSnapshot(leagueId: string, playerId: string): Promise<{ publication: HistoryPublication; snapshot: Snapshot } | null> {
    const publication = await this.getPublication(leagueId, playerId);
    if (!publication) return null;
    const pk = historyPartition(leagueId, playerId), sk = `${generationPrefix(publication.generation)}META`, item = await this.read(pk, sk);
    if (!item) unavailable('Published history generation is missing.');
    const value = historyBody<GenerationRecord>(item!, pk, sk, 'playerHistoryGeneration');
    if (!value || value.phase !== 'published' || value.spec?.generation !== publication.generation ||
      value.spec.context.leagueId !== leagueId || value.spec.context.playerId !== playerId) unavailable('Malformed published history generation.');
    return { publication, snapshot: { pk, sk, item: item!, value } };
  }
  private async unchanged(publication: HistoryPublication): Promise<void> {
    const current = await this.getPublication(publication.leagueId, publication.playerId);
    if (current?.generation !== publication.generation) changed();
  }
  async getSummary(leagueId: string, playerId: string, scope: AchievementScopeContext): Promise<HistorySummary | null> {
    const view = await this.publishedSnapshot(leagueId, playerId);
    if (!view) return null;
    const key = view.snapshot.value.summaryKeys[scopeKey(scope)];
    const state = key ? await this.state(view.snapshot, key) : emptyAccumulator();
    await this.unchanged(view.publication);
    return { state };
  }
  private decodeCursor(cursor: string | undefined, pk: string, generation: string, prefix: string): string | null {
    if (!cursor) return null;
    try {
      if (cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor)) return invalidCursor();
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Cursor;
      if (canonical(Object.keys(parsed).sort()) !== canonical(['generation', 'last', 'pk', 'prefix', 'version']) ||
        parsed.version !== 1 || parsed.pk !== pk || parsed.generation !== generation || parsed.prefix !== prefix ||
        !text(parsed.last) || !parsed.last.startsWith(prefix) || Buffer.byteLength(parsed.last) > 1024) return invalidCursor();
      return parsed.last;
    } catch { return invalidCursor(); }
  }
  private async publicPage<T>(input: { leagueId: string; playerId: string; cursor?: string; limit?: number },
    suffix: string, entityType: string): Promise<HistoryPage<T> | null> {
    const limit = input.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) unavailable('History pages contain between one and twenty entries.');
    const view = await this.publishedSnapshot(input.leagueId, input.playerId);
    if (!view) { if (input.cursor) invalidCursor(); return null; }
    const pk = view.snapshot.pk, generation = view.publication.generation, prefix = `${generationPrefix(generation)}${suffix}`;
    const last = this.decodeCursor(input.cursor, pk, generation, prefix);
    if (last) {
      const row = await this.read(pk, last);
      if (!row || row.entityType?.S !== entityType) invalidCursor();
    }
    const page = await this.query(pk, prefix, last, limit, false);
    const items = page.rows.map(row => historyBody<T>(row, pk, row.sk!.S!, entityType));
    await this.unchanged(view.publication);
    const cursor = page.last ? Buffer.from(canonical({ version: 1, pk, generation, prefix, last: page.last })).toString('base64url') : null;
    return { items, cursor };
  }
  pageMatches(input: { leagueId: string; playerId: string; seasonId?: string; cursor?: string; limit?: number }): Promise<HistoryPage<PlayerAppearance> | null> {
    return this.publicPage(input, input.seasonId === undefined ? 'MATCH#' : `SEASON#${historyHash(input.seasonId)}#MATCH#`, 'playerHistoryAppearance');
  }
  pageAwards(input: { leagueId: string; playerId: string; scope: AchievementScopeContext; cursor?: string; limit?: number }): Promise<HistoryPage<HistoryAward> | null> {
    return this.publicPage(input, `AWARD#${scopeKey(input.scope)}#`, 'playerHistoryAward');
  }
}
