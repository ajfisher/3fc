import {
  DeleteItemCommand,
  GetItemCommand,
  type GetItemCommandOutput,
  PutItemCommand,
  QueryCommand,
  type QueryCommandOutput,
  ScanCommand,
  type ScanCommandOutput,
  TransactWriteItemsCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { randomUUID } from "node:crypto";
import {
  createDefaultThirdTimerSegments,
  DEFAULT_THIRD_LENGTH_MINUTES,
  formatThirdDisplayTime,
  isThirdLengthMinutes,
  THIRD_NUMBERS,
  validateAssistPlayerIds,
  TEAM_IDS,
  type TeamId,
  type ThirdLengthMinutes,
  type ThirdNumber,
  type ThirdTimerSegment,
} from "@3fc/contracts";

import {
  aclSk,
  gamePk,
  gamePlayerSk,
  gameSessionIndexPk,
  gameSessionIndexSk,
  goalAuditSk,
  goalCorrectionOperationSk,
  goalEventIdSk,
  goalStateSk,
  goalSk,
  idempotencyPk,
  leaguePk,
  metadataSk,
  playerPk,
  profileSk,
  rosterSk,
  seasonPk,
  seasonSk,
  sessionPk,
  sessionSk,
  teamSk,
} from "./keys.js";
import type {
  AssignRosterInput,
  CreateGameTeamInput,
  CreateGameInput,
  CreateGoalInput,
  CreateGoalResult,
  CreateIdempotencyRecordInput,
  CreateLeagueInput,
  CreatePlayerInput,
  CreateSeasonInput,
  CreateSessionGameInput,
  CreateSessionInput,
  CreateTeamInput,
  DeleteGoalInput,
  DeleteGoalResult,
  GameTeamRecord,
  GamePlayerRecord,
  GameRecord,
  GoalAuditAction,
  GoalAuditRecord,
  GoalAuditSnapshotRecord,
  GoalCorrectionOperationRecord,
  GoalEventRecord,
  GoalStateRecord,
  IdempotencyRecord,
  LeagueAclRecord,
  LeagueRecord,
  ListPlayersInput,
  LinkGamePlayerInput,
  PlayerRecord,
  RosterAssignmentRecord,
  SeasonRecord,
  SessionGameRecord,
  SessionRecord,
  TeamRecord,
  GrantLeagueAccessInput,
  ThirdTransitionInput,
  UndoLastGoalInput,
  UpdateGoalInput,
  UpdateGoalResult,
} from "./types.js";

const ENTITY_TYPE = {
  league: "league",
  season: "season",
  team: "team",
  session: "session",
  game: "game",
  gameTeam: "gameTeam",
  gamePlayer: "gamePlayer",
  sessionGame: "sessionGame",
  player: "player",
  acl: "acl",
  roster: "roster",
  goal: "goal",
  goalEventId: "goalEventId",
  goalState: "goalState",
  goalAudit: "goalAudit",
  goalCorrectionOperation: "goalCorrectionOperation",
  idempotency: "idempotency",
} as const;

type EntityType = (typeof ENTITY_TYPE)[keyof typeof ENTITY_TYPE];

type Item = Record<string, AttributeValue>;

interface Clock {
  now(): string;
}

interface DynamoCommandClient {
  send(command: unknown): Promise<unknown>;
}

interface QueryByPrefixOptions {
  consistentRead?: boolean;
}

interface StoredEntity<T> {
  pk: string;
  sk: string;
  entityType: EntityType;
  createdAt: string;
  updatedAt: string;
  rawData: string;
  data: T;
}

class DefaultClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

export class GameTimerTransitionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GameTimerTransitionError";
  }
}

export class GoalCreationError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: 400 | 409,
    message: string,
  ) {
    super(message);
    this.name = "GoalCreationError";
  }
}

export class GoalCorrectionError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: 400 | 409,
    message: string,
  ) {
    super(message);
    this.name = "GoalCorrectionError";
  }
}

type GoalRuleErrorKind = "creation" | "correction";

function goalRuleError(
  kind: GoalRuleErrorKind,
  code: string,
  statusCode: 400 | 409,
  message: string,
): GoalCreationError | GoalCorrectionError {
  return kind === "creation"
    ? new GoalCreationError(code, statusCode, message)
    : new GoalCorrectionError(code, statusCode, message);
}

function requireNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
}

function requireThirdNumber(third: number): asserts third is ThirdNumber {
  if (!THIRD_NUMBERS.includes(third as ThirdNumber)) {
    throw new Error("third must be 1, 2, or 3.");
  }
}

function requireTeamId(teamId: string | null, fieldName: string): asserts teamId is TeamId {
  if (teamId === null || !TEAM_IDS.includes(teamId as TeamId)) {
    throw new GoalCreationError(
      "invalid_team",
      400,
      `${fieldName} must be red, blue, or yellow.`,
    );
  }
}

function requireGoalTeamId(
  teamId: string | null,
  fieldName: string,
  errorKind: GoalRuleErrorKind,
): asserts teamId is TeamId {
  if (teamId === null || !TEAM_IDS.includes(teamId as TeamId)) {
    throw goalRuleError(
      errorKind,
      "invalid_team",
      400,
      `${fieldName} must be red, blue, or yellow.`,
    );
  }
}

function isTeamId(value: unknown): value is TeamId {
  return typeof value === "string" && TEAM_IDS.includes(value as TeamId);
}

function normalizeThirdNumber(value: unknown): ThirdNumber {
  return typeof value === "number" && THIRD_NUMBERS.includes(value as ThirdNumber)
    ? (value as ThirdNumber)
    : 1;
}

function normalizeThirdLengthMinutes(value: unknown): ThirdLengthMinutes {
  return typeof value === "number" && isThirdLengthMinutes(value)
    ? value
    : DEFAULT_THIRD_LENGTH_MINUTES;
}

function normalizeThirdTimerSegments(value: unknown): ThirdTimerSegment[] {
  const source = Array.isArray(value) ? value : [];

  return THIRD_NUMBERS.map((third) => {
    const matchingSegment = source.find(
      (segment): segment is Partial<ThirdTimerSegment> =>
        typeof segment === "object" &&
        segment !== null &&
        (segment as { third?: unknown }).third === third,
    );

    return {
      third,
      startedAt: typeof matchingSegment?.startedAt === "string" ? matchingSegment.startedAt : null,
      finishedAt: typeof matchingSegment?.finishedAt === "string" ? matchingSegment.finishedAt : null,
    };
  });
}

function normalizeGamePayload(data: unknown): Omit<GameRecord, "createdAt" | "updatedAt"> {
  const raw = data as Partial<Omit<GameRecord, "createdAt" | "updatedAt">>;

  return {
    gameId: raw.gameId ?? "",
    leagueId: raw.leagueId ?? "",
    seasonId: raw.seasonId ?? "",
    sessionId: raw.sessionId ?? "",
    status: raw.status ?? "scheduled",
    gameStartTs: raw.gameStartTs ?? "",
    thirdLengthMinutes: normalizeThirdLengthMinutes(raw.thirdLengthMinutes),
    thirds: normalizeThirdTimerSegments(raw.thirds),
  };
}

function normalizeNonNegativeInteger(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

function normalizePositiveInteger(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 1 ? (value as number) : 1;
}

function normalizeGameTeamPayload(data: unknown): Omit<GameTeamRecord, "createdAt" | "updatedAt"> {
  const raw = data as Partial<Omit<GameTeamRecord, "createdAt" | "updatedAt">>;

  return {
    gameId: raw.gameId ?? "",
    teamId: isTeamId(raw.teamId) ? raw.teamId : "red",
    name: typeof raw.name === "string" ? raw.name : "",
    color: typeof raw.color === "string" ? raw.color : null,
    scored: normalizeNonNegativeInteger(raw.scored),
    conceded: normalizeNonNegativeInteger(raw.conceded),
  };
}

function normalizeGoalEventPayload(data: unknown): Omit<GoalEventRecord, "createdAt" | "updatedAt"> {
  const raw = data as Partial<Omit<GoalEventRecord, "createdAt" | "updatedAt">>;
  const third = normalizeThirdNumber(raw.third);
  const thirdMinute = normalizePositiveInteger(raw.thirdMinute);
  const gameMinute = normalizePositiveInteger(raw.gameMinute);
  const elapsedSeconds = normalizeNonNegativeInteger(raw.elapsedSeconds);

  return {
    gameId: raw.gameId ?? "",
    eventId: raw.eventId ?? "",
    third,
    thirdMinute,
    gameMinute,
    elapsedSeconds,
    stoppageMinute:
      Number.isInteger(raw.stoppageMinute) && (raw.stoppageMinute as number) >= 1
        ? (raw.stoppageMinute as number)
        : null,
    displayTime: raw.displayTime ?? String(gameMinute),
    scoringTeamId: isTeamId(raw.scoringTeamId) ? raw.scoringTeamId : null,
    concedingTeamId: isTeamId(raw.concedingTeamId) ? raw.concedingTeamId : "red",
    scorerPlayerId: raw.scorerPlayerId ?? "",
    assistPlayerIds: Array.isArray(raw.assistPlayerIds)
      ? raw.assistPlayerIds.filter((playerId): playerId is string => typeof playerId === "string")
      : [],
    ownGoal: raw.ownGoal ?? false,
  };
}

function normalizeGoalStatePayload(data: unknown): Omit<GoalStateRecord, "createdAt" | "updatedAt"> {
  const raw = data as Partial<Omit<GoalStateRecord, "createdAt" | "updatedAt">>;

  return {
    gameId: raw.gameId ?? "",
    latestEventId: typeof raw.latestEventId === "string" ? raw.latestEventId : null,
    latestGoalSk: typeof raw.latestGoalSk === "string" ? raw.latestGoalSk : null,
    revision: normalizeNonNegativeInteger(raw.revision),
  };
}

function normalizeGoalAuditSnapshot(data: unknown): GoalAuditSnapshotRecord | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const raw = data as Partial<GoalAuditSnapshotRecord>;
  const third = raw.third ?? 1;

  return {
    eventId: raw.eventId ?? "",
    third,
    thirdMinute: normalizeNonNegativeInteger(raw.thirdMinute),
    gameMinute: normalizeNonNegativeInteger(raw.gameMinute),
    elapsedSeconds: normalizeNonNegativeInteger(raw.elapsedSeconds),
    stoppageMinute:
      raw.stoppageMinute === null || Number.isInteger(raw.stoppageMinute)
        ? (raw.stoppageMinute ?? null)
        : null,
    displayTime: raw.displayTime ?? String(raw.gameMinute ?? ""),
    scoringTeamId: raw.scoringTeamId ?? null,
    concedingTeamId: raw.concedingTeamId ?? "red",
    scorerPlayerId: raw.scorerPlayerId ?? "",
    assistPlayerIds: Array.isArray(raw.assistPlayerIds)
      ? raw.assistPlayerIds.filter((playerId): playerId is string => typeof playerId === "string")
      : [],
    ownGoal: raw.ownGoal ?? false,
  };
}

function normalizeGoalAuditPayload(data: unknown): Omit<GoalAuditRecord, "createdAt" | "updatedAt"> {
  const raw = data as Partial<Omit<GoalAuditRecord, "createdAt" | "updatedAt">>;

  return {
    auditId: raw.auditId ?? "",
    gameId: raw.gameId ?? "",
    eventId: raw.eventId ?? "",
    actorUserId: raw.actorUserId ?? "",
    action: raw.action ?? "goal_updated",
    before: normalizeGoalAuditSnapshot(raw.before),
    after: normalizeGoalAuditSnapshot(raw.after),
  };
}

function normalizeGoalCorrectionOperationPayload(
  data: unknown,
): Omit<GoalCorrectionOperationRecord, "createdAt" | "updatedAt"> {
  const raw = data as Partial<Omit<GoalCorrectionOperationRecord, "createdAt" | "updatedAt">>;

  return {
    gameId: raw.gameId ?? "",
    eventId: raw.eventId ?? "",
    operationId: raw.operationId ?? "",
    requestHash: raw.requestHash ?? "",
    action: raw.action ?? "goal_updated",
    result: raw.result as GoalCorrectionOperationRecord["result"],
  };
}

function isThirdStarted(game: Pick<GameRecord, "thirds">): boolean {
  return game.thirds.some((third) => third.startedAt !== null);
}

function compareTeamIds(left: TeamId, right: TeamId): number {
  return TEAM_IDS.indexOf(left) - TEAM_IDS.indexOf(right);
}

function sortGameTeams<T extends { teamId: TeamId }>(teams: T[]): T[] {
  return [...teams].sort((left, right) => compareTeamIds(left.teamId, right.teamId));
}

function compareGoalEvents(left: Pick<GoalEventRecord, "third" | "gameMinute" | "elapsedSeconds" | "eventId">, right: Pick<GoalEventRecord, "third" | "gameMinute" | "elapsedSeconds" | "eventId">): number {
  const thirdSort = left.third - right.third;
  if (thirdSort !== 0) {
    return thirdSort;
  }

  const minuteSort = left.gameMinute - right.gameMinute;
  if (minuteSort !== 0) {
    return minuteSort;
  }

  const elapsedSort = left.elapsedSeconds - right.elapsedSeconds;
  if (elapsedSort !== 0) {
    return elapsedSort;
  }

  return left.eventId.localeCompare(right.eventId);
}

function latestGoalEvent(goals: GoalEventRecord[]): GoalEventRecord | null {
  let latest: GoalEventRecord | null = null;
  for (const goal of goals) {
    if (!latest || compareGoalEvents(latest, goal) < 0) {
      latest = goal;
    }
  }

  return latest;
}

function goalAuditSnapshot(goal: GoalEventRecord): GoalAuditSnapshotRecord {
  return {
    eventId: goal.eventId,
    third: goal.third,
    thirdMinute: goal.thirdMinute,
    gameMinute: goal.gameMinute,
    elapsedSeconds: goal.elapsedSeconds,
    stoppageMinute: goal.stoppageMinute,
    displayTime: goal.displayTime,
    scoringTeamId: goal.scoringTeamId,
    concedingTeamId: goal.concedingTeamId,
    scorerPlayerId: goal.scorerPlayerId,
    assistPlayerIds: goal.assistPlayerIds,
    ownGoal: goal.ownGoal,
  };
}

function isConditionalWriteFailure(error: unknown): boolean {
  const awsError = error as {
    name?: string;
    CancellationReasons?: Array<{ Code?: string }>;
    cancellationReasons?: Array<{ Code?: string }>;
  };

  if (awsError.name === "ConditionalCheckFailedException") {
    return true;
  }

  if (awsError.name !== "TransactionCanceledException") {
    return false;
  }

  const cancellationReasons = awsError.CancellationReasons ?? awsError.cancellationReasons ?? [];
  return cancellationReasons.some(
    (reason) =>
      reason.Code === "ConditionalCheckFailed" ||
      reason.Code === "ConditionalCheckFailedException",
  );
}

function readString(value: AttributeValue | undefined, field: string): string {
  if (!value || value.S === undefined) {
    throw new Error(`Missing string attribute \`${field}\`.`);
  }

  return value.S;
}

function buildItem<T>(
  pk: string,
  sk: string,
  entityType: EntityType,
  payload: T,
  now: string,
): Item {
  return buildItemWithTimestamps(pk, sk, entityType, payload, now, now);
}

function buildItemWithTimestamps<T>(
  pk: string,
  sk: string,
  entityType: EntityType,
  payload: T,
  createdAt: string,
  updatedAt: string,
): Item {
  return {
    pk: { S: pk },
    sk: { S: sk },
    entityType: { S: entityType },
    createdAt: { S: createdAt },
    updatedAt: { S: updatedAt },
    data: { S: JSON.stringify(payload) },
  };
}

function parseStoredEntity<T>(item: Item): StoredEntity<T> {
  const rawData = readString(item.data, "data");
  return {
    pk: readString(item.pk, "pk"),
    sk: readString(item.sk, "sk"),
    entityType: readString(item.entityType, "entityType") as EntityType,
    createdAt: readString(item.createdAt, "createdAt"),
    updatedAt: readString(item.updatedAt, "updatedAt"),
    rawData,
    data: JSON.parse(rawData) as T,
  };
}

function withTimestamps<T extends object>(
  payload: T,
  createdAt: string,
  updatedAt: string,
): T & { createdAt: string; updatedAt: string } {
  return {
    ...payload,
    createdAt,
    updatedAt,
  };
}

export class ThreeFcRepository {
  constructor(
    private readonly client: DynamoCommandClient,
    private readonly tableName: string,
    private readonly clock: Clock = new DefaultClock(),
  ) {}

  async createLeague(input: CreateLeagueInput): Promise<LeagueRecord> {
    requireNonEmpty("leagueId", input.leagueId);
    requireNonEmpty("name", input.name);
    requireNonEmpty("createdByUserId", input.createdByUserId);

    const now = this.clock.now();
    const payload = {
      leagueId: input.leagueId,
      name: input.name,
      slug: input.slug ?? null,
      createdByUserId: input.createdByUserId,
    };

    await this.putEntity(leaguePk(input.leagueId), metadataSk(), ENTITY_TYPE.league, payload, now);
    await this.putEntity(
      leaguePk(input.leagueId),
      aclSk(input.createdByUserId),
      ENTITY_TYPE.acl,
      {
        leagueId: input.leagueId,
        userId: input.createdByUserId,
        role: "admin",
        grantedByUserId: input.createdByUserId,
      },
      now,
    );
    return withTimestamps(payload, now, now);
  }

  async getLeague(leagueId: string): Promise<LeagueRecord | null> {
    requireNonEmpty("leagueId", leagueId);
    const item = await this.getEntity(leaguePk(leagueId), metadataSk());

    if (!item || item.entityType !== ENTITY_TYPE.league) {
      return null;
    }

    return withTimestamps(item.data as Omit<LeagueRecord, "createdAt" | "updatedAt">, item.createdAt, item.updatedAt);
  }

  async listLeaguesForUser(userId: string): Promise<LeagueRecord[]> {
    requireNonEmpty("userId", userId);

    const scanResult = (await this.client.send(
      new ScanCommand({
        TableName: this.tableName,
      }),
    )) as ScanCommandOutput;

    const leagueIds = new Set<string>();
    for (const item of scanResult.Items ?? []) {
      if (item.entityType?.S !== ENTITY_TYPE.acl) {
        continue;
      }

      if (!item.data || item.data.S === undefined) {
        // Skip non-repository ACL-shaped items that do not store JSON payloads.
        continue;
      }

      let data: unknown;
      try {
        data = JSON.parse(item.data.S);
      } catch {
        continue;
      }

      if (
        typeof data === "object" &&
        data !== null &&
        typeof (data as { leagueId?: unknown }).leagueId === "string" &&
        typeof (data as { userId?: unknown }).userId === "string" &&
        (data as { userId: string }).userId === userId
      ) {
        leagueIds.add((data as { leagueId: string }).leagueId);
      }
    }

    const leagues = await Promise.all([...leagueIds].map((leagueId) => this.getLeague(leagueId)));
    return leagues
      .filter((league): league is LeagueRecord => league !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async createSeason(input: CreateSeasonInput): Promise<SeasonRecord> {
    requireNonEmpty("leagueId", input.leagueId);
    requireNonEmpty("seasonId", input.seasonId);
    requireNonEmpty("name", input.name);

    const now = this.clock.now();
    const payload = {
      leagueId: input.leagueId,
      seasonId: input.seasonId,
      name: input.name,
      slug: input.slug ?? null,
      startsOn: input.startsOn ?? null,
      endsOn: input.endsOn ?? null,
    };

    await this.putEntity(leaguePk(input.leagueId), seasonSk(input.seasonId), ENTITY_TYPE.season, payload, now);
    await this.putEntity(seasonPk(input.seasonId), metadataSk(), ENTITY_TYPE.season, payload, now);
    return withTimestamps(payload, now, now);
  }

  async getSeason(seasonId: string): Promise<SeasonRecord | null> {
    requireNonEmpty("seasonId", seasonId);
    const item = await this.getEntity(seasonPk(seasonId), metadataSk());

    if (!item || item.entityType !== ENTITY_TYPE.season) {
      return null;
    }

    return withTimestamps(
      item.data as Omit<SeasonRecord, "createdAt" | "updatedAt">,
      item.createdAt,
      item.updatedAt,
    );
  }

  async listSeasonsForLeague(leagueId: string): Promise<SeasonRecord[]> {
    requireNonEmpty("leagueId", leagueId);
    const items = await this.queryByPrefix(leaguePk(leagueId), "SEASON#");

    return items
      .filter((item) => item.entityType === ENTITY_TYPE.season)
      .map((item) =>
        withTimestamps(
          item.data as Omit<SeasonRecord, "createdAt" | "updatedAt">,
          item.createdAt,
          item.updatedAt,
        ),
      );
  }

  async createTeam(input: CreateTeamInput): Promise<TeamRecord> {
    requireNonEmpty("seasonId", input.seasonId);
    requireNonEmpty("name", input.name);

    const now = this.clock.now();
    const payload = {
      seasonId: input.seasonId,
      teamId: input.teamId,
      name: input.name,
      color: input.color ?? null,
    };

    await this.putEntity(seasonPk(input.seasonId), teamSk(input.teamId), ENTITY_TYPE.team, payload, now);
    return withTimestamps(payload, now, now);
  }

  async listTeamsForSeason(seasonId: string): Promise<TeamRecord[]> {
    requireNonEmpty("seasonId", seasonId);
    const items = await this.queryByPrefix(seasonPk(seasonId), "TEAM#");

    return items
      .filter((item) => item.entityType === ENTITY_TYPE.team)
      .map((item) =>
        withTimestamps(
          item.data as Omit<TeamRecord, "createdAt" | "updatedAt">,
          item.createdAt,
          item.updatedAt,
        ),
      );
  }

  async createGameTeamOverride(input: CreateGameTeamInput): Promise<GameTeamRecord> {
    requireNonEmpty("gameId", input.gameId);
    requireNonEmpty("name", input.name);

    const now = this.clock.now();
    const existing = await this.getEntity(gamePk(input.gameId), teamSk(input.teamId));
    const existingPayload = existing ? normalizeGameTeamPayload(existing.data) : null;
    const payload = {
      gameId: input.gameId,
      teamId: input.teamId,
      name: input.name,
      color: input.color ?? null,
      scored: existingPayload?.scored ?? 0,
      conceded: existingPayload?.conceded ?? 0,
    };

    await this.putEntityWithTimestamps(
      gamePk(input.gameId),
      teamSk(input.teamId),
      ENTITY_TYPE.gameTeam,
      payload,
      existing?.createdAt ?? now,
      now,
    );
    return withTimestamps(payload, existing?.createdAt ?? now, now);
  }

  async listTeamsForGame(gameId: string): Promise<GameTeamRecord[]> {
    requireNonEmpty("gameId", gameId);
    const items = await this.queryByPrefix(gamePk(gameId), "TEAM#");

    const teams = items
      .filter((item) => item.entityType === ENTITY_TYPE.gameTeam)
      .map((item) =>
        withTimestamps(
          normalizeGameTeamPayload(item.data),
          item.createdAt,
          item.updatedAt,
        ),
      );

    return sortGameTeams(teams);
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    requireNonEmpty("seasonId", input.seasonId);
    requireNonEmpty("sessionId", input.sessionId);
    requireNonEmpty("sessionDate", input.sessionDate);

    const now = this.clock.now();
    const payload = {
      seasonId: input.seasonId,
      sessionId: input.sessionId,
      sessionDate: input.sessionDate,
    };

    await this.putEntity(
      seasonPk(input.seasonId),
      sessionSk(input.sessionId),
      ENTITY_TYPE.session,
      payload,
      now,
    );
    await this.putEntity(sessionPk(input.sessionId), metadataSk(), ENTITY_TYPE.session, payload, now);
    return withTimestamps(payload, now, now);
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    requireNonEmpty("sessionId", sessionId);
    const item = await this.getEntity(sessionPk(sessionId), metadataSk());

    if (!item || item.entityType !== ENTITY_TYPE.session) {
      return null;
    }

    return withTimestamps(
      item.data as Omit<SessionRecord, "createdAt" | "updatedAt">,
      item.createdAt,
      item.updatedAt,
    );
  }

  async listSessionsForSeason(seasonId: string): Promise<SessionRecord[]> {
    requireNonEmpty("seasonId", seasonId);
    const items = await this.queryByPrefix(seasonPk(seasonId), "SESSION#");

    return items
      .filter((item) => item.entityType === ENTITY_TYPE.session)
      .map((item) =>
        withTimestamps(
          item.data as Omit<SessionRecord, "createdAt" | "updatedAt">,
          item.createdAt,
          item.updatedAt,
        ),
      );
  }

  async createGame(input: CreateGameInput): Promise<GameRecord> {
    requireNonEmpty("gameId", input.gameId);
    requireNonEmpty("leagueId", input.leagueId);
    requireNonEmpty("seasonId", input.seasonId);
    requireNonEmpty("sessionId", input.sessionId);
    requireNonEmpty("gameStartTs", input.gameStartTs);

    const now = this.clock.now();
    const payload = {
      gameId: input.gameId,
      leagueId: input.leagueId,
      seasonId: input.seasonId,
      sessionId: input.sessionId,
      status: input.status ?? "scheduled",
      gameStartTs: input.gameStartTs,
      thirdLengthMinutes: input.thirdLengthMinutes ?? DEFAULT_THIRD_LENGTH_MINUTES,
      thirds: createDefaultThirdTimerSegments(),
    };

    await this.putEntity(gamePk(input.gameId), metadataSk(), ENTITY_TYPE.game, payload, now);
    return withTimestamps(payload, now, now);
  }

  async getGame(gameId: string): Promise<GameRecord | null> {
    requireNonEmpty("gameId", gameId);
    const item = await this.getEntity(gamePk(gameId), metadataSk());

    if (!item || item.entityType !== ENTITY_TYPE.game) {
      return null;
    }

    return withTimestamps(normalizeGamePayload(item.data), item.createdAt, item.updatedAt);
  }

  async createSessionGame(input: CreateSessionGameInput): Promise<SessionGameRecord> {
    requireNonEmpty("sessionId", input.sessionId);
    requireNonEmpty("gameId", input.gameId);
    requireNonEmpty("gameStartTs", input.gameStartTs);
    requireNonEmpty("leagueId", input.leagueId);
    requireNonEmpty("seasonId", input.seasonId);

    const now = this.clock.now();
    const payload = {
      sessionId: input.sessionId,
      gameId: input.gameId,
      gameStartTs: input.gameStartTs,
      leagueId: input.leagueId,
      seasonId: input.seasonId,
    };

    await this.putEntity(
      gameSessionIndexPk(input.sessionId),
      gameSessionIndexSk(input.gameStartTs, input.gameId),
      ENTITY_TYPE.sessionGame,
      payload,
      now,
    );

    return withTimestamps(payload, now, now);
  }

  async listGamesForSession(sessionId: string): Promise<SessionGameRecord[]> {
    requireNonEmpty("sessionId", sessionId);
    const items = await this.queryByPrefix(gameSessionIndexPk(sessionId), "GAME#");

    return items
      .filter((item) => item.entityType === ENTITY_TYPE.sessionGame)
      .map((item) =>
        withTimestamps(
          item.data as Omit<SessionGameRecord, "createdAt" | "updatedAt">,
          item.createdAt,
          item.updatedAt,
        ),
      );
  }

  async listGamesForSeason(seasonId: string): Promise<GameRecord[]> {
    requireNonEmpty("seasonId", seasonId);

    const sessions = await this.listSessionsForSeason(seasonId);
    const sessionGames = await Promise.all(
      sessions.map((session) => this.listGamesForSession(session.sessionId)),
    );

    const orderedSessionGames = sessionGames
      .flat()
      .sort((left, right) => {
        const timestampSort = left.gameStartTs.localeCompare(right.gameStartTs);
        if (timestampSort !== 0) {
          return timestampSort;
        }

        return left.gameId.localeCompare(right.gameId);
      });

    const gameRecords = await Promise.all(
      orderedSessionGames.map((sessionGame) => this.getGame(sessionGame.gameId)),
    );

    return gameRecords.filter((game): game is GameRecord => game !== null);
  }

  async updateGame(input: {
    gameId: string;
    status?: GameRecord["status"];
    gameStartTs?: string;
    thirdLengthMinutes?: ThirdLengthMinutes;
  }): Promise<GameRecord | null> {
    requireNonEmpty("gameId", input.gameId);

    if (
      input.status === undefined &&
      input.gameStartTs === undefined &&
      input.thirdLengthMinutes === undefined
    ) {
      throw new Error("At least one game field must be updated.");
    }

    const gameItem = await this.getEntity(gamePk(input.gameId), metadataSk());
    if (!gameItem || gameItem.entityType !== ENTITY_TYPE.game) {
      return null;
    }

    const existing = normalizeGamePayload(gameItem.data);
    const nextGameStartTs = input.gameStartTs ?? existing.gameStartTs;
    const nextStatus = input.status ?? existing.status;
    const nextThirdLengthMinutes = input.thirdLengthMinutes ?? existing.thirdLengthMinutes;

    if (
      input.thirdLengthMinutes !== undefined &&
      input.thirdLengthMinutes !== existing.thirdLengthMinutes &&
      existing.status === "finished"
    ) {
      throw new GameTimerTransitionError(
        "game_finished",
        "Third length cannot be changed after the game is finished.",
      );
    }

    if (
      input.thirdLengthMinutes !== undefined &&
      input.thirdLengthMinutes !== existing.thirdLengthMinutes &&
      isThirdStarted(existing)
    ) {
      throw new GameTimerTransitionError(
        "third_length_locked",
        "Third length cannot be changed after a third has started.",
      );
    }

    if (input.status === "scheduled" && isThirdStarted(existing)) {
      throw new GameTimerTransitionError(
        "timer_status_locked",
        "Game status cannot be set back to scheduled after a third has started.",
      );
    }

    const updatedPayload = {
      ...existing,
      gameStartTs: nextGameStartTs,
      status: nextStatus,
      thirdLengthMinutes: nextThirdLengthMinutes,
    };

    const now = this.clock.now();

    const gameUpdated = await this.putEntityWithTimestampsIfUnchanged(
      gamePk(existing.gameId),
      metadataSk(),
      ENTITY_TYPE.game,
      updatedPayload,
      gameItem.createdAt,
      now,
      {
        updatedAt: gameItem.updatedAt,
        rawData: gameItem.rawData,
      },
    );
    if (!gameUpdated) {
      throw new GameTimerTransitionError(
        "game_state_changed",
        "Game state changed while applying this update. Reload and try again.",
      );
    }

    const oldSessionGameSk = gameSessionIndexSk(existing.gameStartTs, existing.gameId);
    const oldSessionGameItem = await this.getEntity(
      gameSessionIndexPk(existing.sessionId),
      oldSessionGameSk,
    );

    if (oldSessionGameItem) {
      await this.deleteEntity(gameSessionIndexPk(existing.sessionId), oldSessionGameSk);
    }

    const sessionGameCreatedAt = oldSessionGameItem?.createdAt ?? now;
    await this.putEntityWithTimestamps(
      gameSessionIndexPk(existing.sessionId),
      gameSessionIndexSk(nextGameStartTs, existing.gameId),
      ENTITY_TYPE.sessionGame,
      {
        sessionId: existing.sessionId,
        gameId: existing.gameId,
        gameStartTs: nextGameStartTs,
        leagueId: existing.leagueId,
        seasonId: existing.seasonId,
      },
      sessionGameCreatedAt,
      now,
    );

    return withTimestamps(updatedPayload, gameItem.createdAt, now);
  }

  async startGameThird(input: ThirdTransitionInput): Promise<GameRecord | null> {
    requireNonEmpty("gameId", input.gameId);
    requireThirdNumber(input.third);

    const gameItem = await this.getEntity(gamePk(input.gameId), metadataSk());
    if (!gameItem || gameItem.entityType !== ENTITY_TYPE.game) {
      return null;
    }

    const existing = normalizeGamePayload(gameItem.data);
    if (existing.status === "finished") {
      throw new GameTimerTransitionError(
        "game_finished",
        "Cannot start a third after the game is finished.",
      );
    }

    const thirds = existing.thirds.map((third) => ({ ...third }));
    const target = thirds.find((third) => third.third === input.third);
    if (!target) {
      throw new GameTimerTransitionError("invalid_third", "Third must be 1, 2, or 3.");
    }

    if (target.startedAt) {
      throw new GameTimerTransitionError(
        "third_already_started",
        `Third ${input.third} has already been started.`,
      );
    }

    const runningThird = thirds.find((third) => third.startedAt && !third.finishedAt);
    if (runningThird) {
      throw new GameTimerTransitionError(
        "third_already_running",
        `Third ${runningThird.third} must be finished before another third can start.`,
      );
    }

    const previousThirds = thirds.filter((third) => third.third < input.third);
    const unfinishedPreviousThird = previousThirds.find((third) => !third.finishedAt);
    if (unfinishedPreviousThird) {
      throw new GameTimerTransitionError(
        "previous_third_unfinished",
        `Third ${unfinishedPreviousThird.third} must be finished before third ${input.third} can start.`,
      );
    }

    const now = this.clock.now();
    target.startedAt = now;
    const updatedPayload = {
      ...existing,
      status: "live" as const,
      thirds,
    };

    const transitionApplied = await this.putEntityWithTimestampsIfUnchanged(
      gamePk(existing.gameId),
      metadataSk(),
      ENTITY_TYPE.game,
      updatedPayload,
      gameItem.createdAt,
      now,
      {
        updatedAt: gameItem.updatedAt,
        rawData: gameItem.rawData,
      },
    );
    if (!transitionApplied) {
      throw new GameTimerTransitionError(
        "timer_state_changed",
        "Timer state changed while applying this transition. Reload the game and try again.",
      );
    }

    return withTimestamps(updatedPayload, gameItem.createdAt, now);
  }

  async finishGameThird(input: ThirdTransitionInput): Promise<GameRecord | null> {
    requireNonEmpty("gameId", input.gameId);
    requireThirdNumber(input.third);

    const gameItem = await this.getEntity(gamePk(input.gameId), metadataSk());
    if (!gameItem || gameItem.entityType !== ENTITY_TYPE.game) {
      return null;
    }

    const existing = normalizeGamePayload(gameItem.data);
    if (existing.status === "finished") {
      throw new GameTimerTransitionError(
        "game_finished",
        "Cannot finish a third after the game is finished.",
      );
    }

    const thirds = existing.thirds.map((third) => ({ ...third }));
    const target = thirds.find((third) => third.third === input.third);
    if (!target) {
      throw new GameTimerTransitionError("invalid_third", "Third must be 1, 2, or 3.");
    }

    if (!target.startedAt) {
      throw new GameTimerTransitionError(
        "third_not_started",
        `Third ${input.third} cannot be finished before it is started.`,
      );
    }

    if (target.finishedAt) {
      throw new GameTimerTransitionError(
        "third_already_finished",
        `Third ${input.third} has already been finished.`,
      );
    }

    const now = this.clock.now();
    target.finishedAt = now;
    const updatedPayload = {
      ...existing,
      status: existing.status === "scheduled" ? ("live" as const) : existing.status,
      thirds,
    };

    const transitionApplied = await this.putEntityWithTimestampsIfUnchanged(
      gamePk(existing.gameId),
      metadataSk(),
      ENTITY_TYPE.game,
      updatedPayload,
      gameItem.createdAt,
      now,
      {
        updatedAt: gameItem.updatedAt,
        rawData: gameItem.rawData,
      },
    );
    if (!transitionApplied) {
      throw new GameTimerTransitionError(
        "timer_state_changed",
        "Timer state changed while applying this transition. Reload the game and try again.",
      );
    }

    return withTimestamps(updatedPayload, gameItem.createdAt, now);
  }

  async deleteGame(gameId: string): Promise<boolean> {
    requireNonEmpty("gameId", gameId);

    const gameItem = await this.getEntity(gamePk(gameId), metadataSk());
    if (!gameItem || gameItem.entityType !== ENTITY_TYPE.game) {
      return false;
    }

    const game = normalizeGamePayload(gameItem.data);

    await this.deleteEntity(gamePk(gameId), metadataSk());
    await this.deleteEntity(
      gameSessionIndexPk(game.sessionId),
      gameSessionIndexSk(game.gameStartTs, game.gameId),
    );

    const remainingGames = await this.listGamesForSession(game.sessionId);
    if (remainingGames.length === 0) {
      await this.deleteEntity(seasonPk(game.seasonId), sessionSk(game.sessionId));
      await this.deleteEntity(sessionPk(game.sessionId), metadataSk());
    }

    return true;
  }

  async deleteSeason(seasonId: string): Promise<boolean> {
    requireNonEmpty("seasonId", seasonId);

    const season = await this.getSeason(seasonId);
    if (!season) {
      return false;
    }

    const sessions = await this.listSessionsForSeason(seasonId);
    if (sessions.length > 0) {
      throw new Error("Cannot delete season with existing games.");
    }

    await this.deleteEntity(seasonPk(seasonId), metadataSk());
    await this.deleteEntity(leaguePk(season.leagueId), seasonSk(seasonId));
    return true;
  }

  async deleteLeague(leagueId: string): Promise<boolean> {
    requireNonEmpty("leagueId", leagueId);

    const league = await this.getLeague(leagueId);
    if (!league) {
      return false;
    }

    const seasons = await this.listSeasonsForLeague(leagueId);
    if (seasons.length > 0) {
      throw new Error("Cannot delete league with existing seasons.");
    }

    const aclEntries = await this.listLeagueAccess(leagueId);
    await Promise.all(
      aclEntries.map((entry) => this.deleteEntity(leaguePk(leagueId), aclSk(entry.userId))),
    );
    await this.deleteEntity(leaguePk(leagueId), metadataSk());
    return true;
  }

  async createPlayer(input: CreatePlayerInput): Promise<PlayerRecord> {
    requireNonEmpty("playerId", input.playerId);
    requireNonEmpty("nickname", input.nickname);

    const now = this.clock.now();
    const payload = {
      playerId: input.playerId,
      nickname: input.nickname,
      claimedByUserId: input.claimedByUserId ?? null,
    };

    await this.putEntity(playerPk(input.playerId), profileSk(), ENTITY_TYPE.player, payload, now);
    return withTimestamps(payload, now, now);
  }

  async getPlayer(playerId: string): Promise<PlayerRecord | null> {
    requireNonEmpty("playerId", playerId);
    const item = await this.getEntity(playerPk(playerId), profileSk());

    if (!item || item.entityType !== ENTITY_TYPE.player) {
      return null;
    }

    return withTimestamps(item.data as Omit<PlayerRecord, "createdAt" | "updatedAt">, item.createdAt, item.updatedAt);
  }

  async listPlayers(input: ListPlayersInput = {}): Promise<PlayerRecord[]> {
    const rawSearch = input.search?.trim().toLowerCase() ?? "";
    const limit = Math.max(1, Math.min(input.limit ?? 20, 50));
    const scanResult = (await this.client.send(
      new ScanCommand({
        TableName: this.tableName,
      }),
    )) as ScanCommandOutput;

    return (scanResult.Items ?? [])
      .filter((item) => item.entityType?.S === ENTITY_TYPE.player)
      .map((item) => parseStoredEntity<Omit<PlayerRecord, "createdAt" | "updatedAt">>(item))
      .map((item) => withTimestamps(item.data, item.createdAt, item.updatedAt))
      .filter((player) => rawSearch.length === 0 || player.nickname.toLowerCase().includes(rawSearch))
      .sort((left, right) => {
        const updatedSort = right.updatedAt.localeCompare(left.updatedAt);
        if (updatedSort !== 0) {
          return updatedSort;
        }

        return left.nickname.localeCompare(right.nickname);
      })
      .slice(0, limit);
  }

  async linkGamePlayer(input: LinkGamePlayerInput): Promise<GamePlayerRecord> {
    requireNonEmpty("gameId", input.gameId);
    requireNonEmpty("playerId", input.playerId);

    const now = this.clock.now();
    const existing = await this.getEntity(gamePk(input.gameId), gamePlayerSk(input.playerId));
    const payload = {
      gameId: input.gameId,
      playerId: input.playerId,
    };

    await this.putEntityWithTimestamps(
      gamePk(input.gameId),
      gamePlayerSk(input.playerId),
      ENTITY_TYPE.gamePlayer,
      payload,
      existing?.createdAt ?? now,
      now,
    );

    return withTimestamps(payload, existing?.createdAt ?? now, now);
  }

  async listGamePlayers(gameId: string): Promise<GamePlayerRecord[]> {
    requireNonEmpty("gameId", gameId);
    const items = await this.queryByPrefix(gamePk(gameId), "PLAYER#");

    return items
      .filter((item) => item.entityType === ENTITY_TYPE.gamePlayer)
      .map((item) =>
        withTimestamps(
          item.data as Omit<GamePlayerRecord, "createdAt" | "updatedAt">,
          item.createdAt,
          item.updatedAt,
        ),
      );
  }

  async grantLeagueAccess(input: GrantLeagueAccessInput): Promise<LeagueAclRecord> {
    requireNonEmpty("leagueId", input.leagueId);
    requireNonEmpty("userId", input.userId);
    requireNonEmpty("grantedByUserId", input.grantedByUserId);

    const now = this.clock.now();
    const payload = {
      leagueId: input.leagueId,
      userId: input.userId,
      role: input.role,
      grantedByUserId: input.grantedByUserId,
    };

    await this.putEntity(leaguePk(input.leagueId), aclSk(input.userId), ENTITY_TYPE.acl, payload, now);
    return withTimestamps(payload, now, now);
  }

  async listLeagueAccess(leagueId: string): Promise<LeagueAclRecord[]> {
    requireNonEmpty("leagueId", leagueId);
    const items = await this.queryByPrefix(leaguePk(leagueId), "ACL#USER#");

    return items
      .filter((item) => item.entityType === ENTITY_TYPE.acl)
      .map((item) =>
        withTimestamps(
          item.data as Omit<LeagueAclRecord, "createdAt" | "updatedAt">,
          item.createdAt,
          item.updatedAt,
        ),
      );
  }

  async getLeagueAccess(leagueId: string, userId: string): Promise<LeagueAclRecord | null> {
    requireNonEmpty("leagueId", leagueId);
    requireNonEmpty("userId", userId);
    const item = await this.getEntity(leaguePk(leagueId), aclSk(userId));

    if (!item || item.entityType !== ENTITY_TYPE.acl) {
      return null;
    }

    return withTimestamps(
      item.data as Omit<LeagueAclRecord, "createdAt" | "updatedAt">,
      item.createdAt,
      item.updatedAt,
    );
  }

  async assignRosterPlayer(input: AssignRosterInput): Promise<RosterAssignmentRecord> {
    requireNonEmpty("gameId", input.gameId);
    requireNonEmpty("playerId", input.playerId);

    const existingAssignments = await this.listGameRoster(input.gameId);
    const currentAssignmentsForPlayer = existingAssignments.filter(
      (assignment) => assignment.playerId === input.playerId,
    );
    const existingAssignment = currentAssignmentsForPlayer.find(
      (assignment) => assignment.teamId === input.teamId,
    );
    if (existingAssignment) {
      return existingAssignment;
    }

    const now = this.clock.now();
    const payload = {
      gameId: input.gameId,
      teamId: input.teamId,
      playerId: input.playerId,
    };

    await Promise.all(
      currentAssignmentsForPlayer.map((assignment) =>
        this.deleteEntity(gamePk(input.gameId), rosterSk(assignment.teamId, assignment.playerId)),
      ),
    );
    await this.linkGamePlayer({
      gameId: input.gameId,
      playerId: input.playerId,
    });
    await this.putEntity(
      gamePk(input.gameId),
      rosterSk(input.teamId, input.playerId),
      ENTITY_TYPE.roster,
      payload,
      now,
    );
    return withTimestamps(payload, now, now);
  }

  async listGameRoster(gameId: string): Promise<RosterAssignmentRecord[]> {
    requireNonEmpty("gameId", gameId);
    const items = await this.queryByPrefix(gamePk(gameId), "ROSTER#");

    return items
      .filter((item) => item.entityType === ENTITY_TYPE.roster)
      .map((item) =>
        withTimestamps(
          item.data as Omit<RosterAssignmentRecord, "createdAt" | "updatedAt">,
          item.createdAt,
          item.updatedAt,
        ),
      );
  }

  private async readGoalTeamStates(
    gameId: string,
    options: { consistentRead?: boolean } = {},
  ): Promise<{
    teams: GameTeamRecord[];
    teamStatesById: Map<TeamId, { record: GameTeamRecord; rawData: string }>;
  }> {
    const teamItems = await this.queryByPrefix(gamePk(gameId), "TEAM#", options);
    const teamStates = teamItems
      .filter((item) => item.entityType === ENTITY_TYPE.gameTeam)
      .map((item) => ({
        record: withTimestamps(
          normalizeGameTeamPayload(item.data),
          item.createdAt,
          item.updatedAt,
        ),
        rawData: item.rawData,
      }));

    return {
      teams: sortGameTeams(teamStates.map((teamState) => teamState.record)),
      teamStatesById: new Map(teamStates.map((teamState) => [teamState.record.teamId, teamState])),
    };
  }

  private validateGoalRules(
    input: {
      gameId: string;
      scoringTeamId: TeamId | null;
      concedingTeamId: TeamId;
      scorerPlayerId: string;
      assistPlayerIds: string[];
      ownGoal: boolean;
    },
    teams: GameTeamRecord[],
    roster: RosterAssignmentRecord[],
    errorKind: GoalRuleErrorKind,
  ): void {
    requireGoalTeamId(input.concedingTeamId, "concedingTeamId", errorKind);
    if (input.scoringTeamId !== null) {
      requireGoalTeamId(input.scoringTeamId, "scoringTeamId", errorKind);
    }

    try {
      validateAssistPlayerIds(input.scorerPlayerId, input.assistPlayerIds);
    } catch (error) {
      throw goalRuleError(
        errorKind,
        "invalid_assists",
        400,
        error instanceof Error ? error.message : "Assist player IDs are invalid.",
      );
    }

    if (input.ownGoal && input.scoringTeamId !== null) {
      throw goalRuleError(
        errorKind,
        "own_goal_scoring_team",
        400,
        "ownGoal=true requires scoringTeamId to be null.",
      );
    }

    if (!input.ownGoal && input.scoringTeamId === null) {
      throw goalRuleError(
        errorKind,
        "scoring_team_required",
        400,
        "scoringTeamId is required when ownGoal=false.",
      );
    }

    if (!input.ownGoal && input.scoringTeamId === input.concedingTeamId) {
      throw goalRuleError(
        errorKind,
        "same_team_goal",
        400,
        "scoringTeamId and concedingTeamId must be different for a standard goal.",
      );
    }

    const teamsById = new Map(teams.map((team) => [team.teamId, team]));
    const concedingTeam = teamsById.get(input.concedingTeamId);
    if (!concedingTeam) {
      throw goalRuleError(
        errorKind,
        "invalid_conceding_team",
        400,
        "concedingTeamId must be an active team for this game.",
      );
    }

    const scoringTeam = input.scoringTeamId ? teamsById.get(input.scoringTeamId) : null;
    if (!input.ownGoal && !scoringTeam) {
      throw goalRuleError(
        errorKind,
        "invalid_scoring_team",
        400,
        "scoringTeamId must be an active team for this game.",
      );
    }

    const rosterByPlayerId = new Map(roster.map((assignment) => [assignment.playerId, assignment]));
    const scorerRoster = rosterByPlayerId.get(input.scorerPlayerId);
    if (!scorerRoster) {
      throw goalRuleError(
        errorKind,
        "scorer_not_rostered",
        400,
        "Scorer must be rostered in this game.",
      );
    }

    if (!input.ownGoal && scorerRoster.teamId !== input.scoringTeamId) {
      throw goalRuleError(
        errorKind,
        "scorer_not_on_scoring_team",
        400,
        "Scorer must be rostered on the scoring team for a standard goal.",
      );
    }

    if (input.ownGoal && scorerRoster.teamId !== input.concedingTeamId) {
      throw goalRuleError(
        errorKind,
        "scorer_not_on_conceding_team",
        400,
        "Own-goal scorer must be rostered on the conceding team.",
      );
    }

    for (const assistPlayerId of input.assistPlayerIds) {
      if (!rosterByPlayerId.has(assistPlayerId)) {
        throw goalRuleError(
          errorKind,
          "assist_not_rostered",
          400,
          "Assist players must be rostered in this game.",
        );
      }
    }
  }

  private recomputeTeamsFromGoals(
    gameId: string,
    teams: GameTeamRecord[],
    timeline: GoalEventRecord[],
    now: string,
  ): GameTeamRecord[] {
    const countsByTeamId = new Map<TeamId, { scored: number; conceded: number }>();
    for (const team of teams) {
      countsByTeamId.set(team.teamId, { scored: 0, conceded: 0 });
    }

    for (const goal of timeline) {
      if (!goal.ownGoal && goal.scoringTeamId) {
        const scoringCounts = countsByTeamId.get(goal.scoringTeamId);
        if (scoringCounts) {
          scoringCounts.scored += 1;
        }
      }

      const concedingCounts = countsByTeamId.get(goal.concedingTeamId);
      if (concedingCounts) {
        concedingCounts.conceded += 1;
      }
    }

    return sortGameTeams(
      teams.map((team) => {
        const counts = countsByTeamId.get(team.teamId) ?? { scored: 0, conceded: 0 };
        const changed = team.scored !== counts.scored || team.conceded !== counts.conceded;
        return {
          ...team,
          scored: counts.scored,
          conceded: counts.conceded,
          updatedAt: changed ? now : team.updatedAt,
        };
      }),
    );
  }

  private async findGoalByEventId(
    gameId: string,
    eventId: string,
    options: { consistentRead?: boolean } = {},
  ): Promise<{ goal: GoalEventRecord; sk: string; stored: StoredEntity<unknown> } | null> {
    const marker = await this.getEntity(gamePk(gameId), goalEventIdSk(eventId), options);
    const markerGoalSk =
      marker?.entityType === ENTITY_TYPE.goalEventId &&
      typeof (marker.data as { goalSk?: unknown }).goalSk === "string"
        ? (marker.data as { goalSk: string }).goalSk
        : null;

    if (markerGoalSk) {
      const stored = await this.getEntity(gamePk(gameId), markerGoalSk, options);
      if (stored?.entityType === ENTITY_TYPE.goal) {
        return {
          goal: withTimestamps(
            normalizeGoalEventPayload(stored.data),
            stored.createdAt,
            stored.updatedAt,
          ),
          sk: stored.sk,
          stored,
        };
      }
    }

    const goalItems = await this.queryByPrefix(gamePk(gameId), "GOAL#", options);
    const stored = goalItems.find(
      (item) =>
        item.entityType === ENTITY_TYPE.goal &&
        normalizeGoalEventPayload(item.data).eventId === eventId,
    );

    if (!stored) {
      return null;
    }

    return {
      goal: withTimestamps(normalizeGoalEventPayload(stored.data), stored.createdAt, stored.updatedAt),
      sk: stored.sk,
      stored,
    };
  }

  private async getGoalState(
    gameId: string,
    options: { consistentRead?: boolean } = {},
  ): Promise<{ state: GoalStateRecord; rawData: string } | null> {
    const stored = await this.getEntity(gamePk(gameId), goalStateSk(), options);
    if (!stored || stored.entityType !== ENTITY_TYPE.goalState) {
      return null;
    }

    return {
      state: withTimestamps(
        normalizeGoalStatePayload(stored.data),
        stored.createdAt,
        stored.updatedAt,
      ),
      rawData: stored.rawData,
    };
  }

  private buildGoalStateWrite(
    gameId: string,
    latest: GoalEventRecord | null,
    latestGoalSk: string | null,
    now: string,
    existing: { state: GoalStateRecord; rawData: string } | null,
  ) {
    const payload = {
      gameId,
      latestEventId: latest?.eventId ?? null,
      latestGoalSk,
      revision: (existing?.state.revision ?? 0) + 1,
    };
    const basePut = {
      TableName: this.tableName,
      Item: buildItemWithTimestamps(
        gamePk(gameId),
        goalStateSk(),
        ENTITY_TYPE.goalState,
        payload,
        existing?.state.createdAt ?? now,
        now,
      ),
    };

    if (!existing) {
      return {
        Put: {
          ...basePut,
          ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        },
      };
    }

    return {
      Put: {
        ...basePut,
        ConditionExpression: "#updatedAt = :expectedGoalStateUpdatedAt AND #data = :expectedGoalStateData",
        ExpressionAttributeNames: {
          "#updatedAt": "updatedAt",
          "#data": "data",
        },
        ExpressionAttributeValues: {
          ":expectedGoalStateUpdatedAt": { S: existing.state.updatedAt },
          ":expectedGoalStateData": { S: existing.rawData },
        },
      },
    };
  }

  private buildGoalAuditRecord(input: {
    gameId: string;
    eventId: string;
    actorUserId: string;
    action: GoalAuditAction;
    before: GoalEventRecord | null;
    after: GoalEventRecord | null;
    now: string;
  }): GoalAuditRecord {
    return {
      auditId: randomUUID(),
      gameId: input.gameId,
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      action: input.action,
      before: input.before ? goalAuditSnapshot(input.before) : null,
      after: input.after ? goalAuditSnapshot(input.after) : null,
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  private buildTeamPutTransactionItems(
    teams: GameTeamRecord[],
    originalTeamStatesById: Map<TeamId, { record: GameTeamRecord; rawData: string }>,
    now: string,
  ) {
    return teams.map((team) => {
      const original = originalTeamStatesById.get(team.teamId);
      if (!original) {
        throw new GoalCorrectionError(
          "scoreboard_state_changed",
          409,
          "Scoreboard changed while correcting this goal. Reload the game and try again.",
        );
      }

      return {
        Put: {
          TableName: this.tableName,
          Item: buildItemWithTimestamps(
            gamePk(team.gameId),
            teamSk(team.teamId),
            ENTITY_TYPE.gameTeam,
            {
              gameId: team.gameId,
              teamId: team.teamId,
              name: team.name,
              color: team.color,
              scored: team.scored,
              conceded: team.conceded,
            },
            team.createdAt,
            team.updatedAt === original.record.updatedAt ? original.record.updatedAt : now,
          ),
          ConditionExpression: "#updatedAt = :expectedUpdatedAt AND #data = :expectedData",
          ExpressionAttributeNames: {
            "#updatedAt": "updatedAt",
            "#data": "data",
          },
          ExpressionAttributeValues: {
            ":expectedUpdatedAt": { S: original.record.updatedAt },
            ":expectedData": { S: original.rawData },
          },
        },
      };
    });
  }

  private buildGoalAuditPut(audit: GoalAuditRecord) {
    return {
      Put: {
        TableName: this.tableName,
        Item: buildItemWithTimestamps(
          gamePk(audit.gameId),
          goalAuditSk(audit.createdAt, audit.auditId),
          ENTITY_TYPE.goalAudit,
          {
            auditId: audit.auditId,
            gameId: audit.gameId,
            eventId: audit.eventId,
            actorUserId: audit.actorUserId,
            action: audit.action,
            before: audit.before,
            after: audit.after,
          },
          audit.createdAt,
          audit.updatedAt,
        ),
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      },
    };
  }

  private normalizeCorrectionOperation(input: {
    operationId?: string | null;
    operationRequestHash?: string | null;
  }): { operationId: string; requestHash: string } | null {
    const operationId = input.operationId?.trim() ?? "";
    const requestHash = input.operationRequestHash?.trim() ?? "";
    if (!operationId && !requestHash) {
      return null;
    }

    if (!operationId || !requestHash) {
      throw new GoalCorrectionError(
        "invalid_correction_operation",
        400,
        "Correction operation id and request hash must be provided together.",
      );
    }

    return {
      operationId,
      requestHash,
    };
  }

  private buildGoalCorrectionOperationPut(input: {
    gameId: string;
    eventId: string;
    operationId: string;
    requestHash: string;
    action: Extract<GoalAuditAction, "goal_updated" | "goal_deleted" | "goal_undo_last">;
    result: GoalCorrectionOperationRecord["result"];
    now: string;
  }) {
    return {
      Put: {
        TableName: this.tableName,
        Item: buildItem(
          gamePk(input.gameId),
          goalCorrectionOperationSk(input.operationId),
          ENTITY_TYPE.goalCorrectionOperation,
          {
            gameId: input.gameId,
            eventId: input.eventId,
            operationId: input.operationId,
            requestHash: input.requestHash,
            action: input.action,
            result: input.result,
          },
          input.now,
        ),
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      },
    };
  }

  private async getGoalCorrectionOperation(
    gameId: string,
    operationId: string,
  ): Promise<GoalCorrectionOperationRecord | null> {
    const stored = await this.getEntity(
      gamePk(gameId),
      goalCorrectionOperationSk(operationId),
      { consistentRead: true },
    );
    if (!stored || stored.entityType !== ENTITY_TYPE.goalCorrectionOperation) {
      return null;
    }

    return withTimestamps(
      normalizeGoalCorrectionOperationPayload(stored.data),
      stored.createdAt,
      stored.updatedAt,
    );
  }

  private async replayGoalCorrectionOperation<T extends UpdateGoalResult | DeleteGoalResult>(
    gameId: string,
    operation: { operationId: string; requestHash: string } | null,
  ): Promise<T | null> {
    if (!operation) {
      return null;
    }

    const existingOperation = await this.getGoalCorrectionOperation(gameId, operation.operationId);
    if (!existingOperation) {
      return null;
    }

    if (existingOperation.requestHash !== operation.requestHash) {
      throw new GoalCorrectionError(
        "idempotency_conflict",
        409,
        "Correction operation id has already been used with a different request payload.",
      );
    }

    return existingOperation.result as T;
  }

  async createGoal(input: CreateGoalInput): Promise<CreateGoalResult | null> {
    requireNonEmpty("gameId", input.gameId);
    requireNonEmpty("eventId", input.eventId);
    requireNonEmpty("actorUserId", input.actorUserId);
    requireNonEmpty("concedingTeamId", input.concedingTeamId);
    requireNonEmpty("scorerPlayerId", input.scorerPlayerId);
    requireTeamId(input.concedingTeamId, "concedingTeamId");
    if (input.scoringTeamId !== null) {
      requireTeamId(input.scoringTeamId, "scoringTeamId");
    }

    try {
      validateAssistPlayerIds(input.scorerPlayerId, input.assistPlayerIds);
    } catch (error) {
      throw new GoalCreationError(
        "invalid_assists",
        400,
        error instanceof Error ? error.message : "Assist player IDs are invalid.",
      );
    }

    if (input.ownGoal && input.scoringTeamId !== null) {
      throw new GoalCreationError(
        "own_goal_scoring_team",
        400,
        "ownGoal=true requires scoringTeamId to be null.",
      );
    }

    if (!input.ownGoal && input.scoringTeamId === null) {
      throw new GoalCreationError(
        "scoring_team_required",
        400,
        "scoringTeamId is required when ownGoal=false.",
      );
    }

    if (!input.ownGoal && input.scoringTeamId === input.concedingTeamId) {
      throw new GoalCreationError(
        "same_team_goal",
        400,
        "scoringTeamId and concedingTeamId must be different for a standard goal.",
      );
    }

    const gameItem = await this.getEntity(gamePk(input.gameId), metadataSk());
    if (!gameItem || gameItem.entityType !== ENTITY_TYPE.game) {
      return null;
    }

    const game = normalizeGamePayload(gameItem.data);
    const activeThird = game.thirds.find((third) => third.startedAt && !third.finishedAt);
    if (!activeThird?.startedAt) {
      throw new GoalCreationError(
        "no_active_third",
        409,
        "A goal can only be created while a third is running.",
      );
    }

    const teamItems = await this.queryByPrefix(gamePk(input.gameId), "TEAM#", {
      consistentRead: true,
    });
    const teamStates = teamItems
      .filter((item) => item.entityType === ENTITY_TYPE.gameTeam)
      .map((item) => ({
        record: withTimestamps(
          normalizeGameTeamPayload(item.data),
          item.createdAt,
          item.updatedAt,
        ),
        rawData: item.rawData,
      }));
    const teams = sortGameTeams(teamStates.map((teamState) => teamState.record));
    const teamsById = new Map(teams.map((team) => [team.teamId, team]));
    const teamStatesById = new Map(teamStates.map((teamState) => [teamState.record.teamId, teamState]));
    const concedingTeam = teamsById.get(input.concedingTeamId);
    if (!concedingTeam) {
      throw new GoalCreationError(
        "invalid_conceding_team",
        400,
        "concedingTeamId must be an active team for this game.",
      );
    }

    const scoringTeam = input.scoringTeamId ? teamsById.get(input.scoringTeamId) : null;
    if (!input.ownGoal && !scoringTeam) {
      throw new GoalCreationError(
        "invalid_scoring_team",
        400,
        "scoringTeamId must be an active team for this game.",
      );
    }

    const roster = await this.listGameRoster(input.gameId);
    const rosterByPlayerId = new Map(roster.map((assignment) => [assignment.playerId, assignment]));
    const scorerRoster = rosterByPlayerId.get(input.scorerPlayerId);
    if (!scorerRoster) {
      throw new GoalCreationError(
        "scorer_not_rostered",
        400,
        "Scorer must be rostered in this game.",
      );
    }

    if (!input.ownGoal && scorerRoster.teamId !== input.scoringTeamId) {
      throw new GoalCreationError(
        "scorer_not_on_scoring_team",
        400,
        "Scorer must be rostered on the scoring team for a standard goal.",
      );
    }

    if (input.ownGoal && scorerRoster.teamId !== input.concedingTeamId) {
      throw new GoalCreationError(
        "scorer_not_on_conceding_team",
        400,
        "Own-goal scorer must be rostered on the conceding team.",
      );
    }

    for (const assistPlayerId of input.assistPlayerIds) {
      if (!rosterByPlayerId.has(assistPlayerId)) {
        throw new GoalCreationError(
          "assist_not_rostered",
          400,
          "Assist players must be rostered in this game.",
        );
      }
    }

    const now = this.clock.now();
    const startedAtMs = Date.parse(activeThird.startedAt);
    const nowMs = Date.parse(now);
    const elapsedSeconds =
      Number.isFinite(startedAtMs) && Number.isFinite(nowMs)
        ? Math.max(0, Math.floor((nowMs - startedAtMs) / 1000))
        : 0;
    const display = formatThirdDisplayTime(elapsedSeconds, game.thirdLengthMinutes);
    const thirdMinute = Math.min(
      game.thirdLengthMinutes,
      Math.floor(display.elapsedSeconds / 60) + 1,
    );
    const gameMinute = (activeThird.third - 1) * game.thirdLengthMinutes + thirdMinute;
    const payload = {
      gameId: input.gameId,
      eventId: input.eventId,
      third: activeThird.third,
      thirdMinute,
      gameMinute,
      elapsedSeconds: display.elapsedSeconds,
      stoppageMinute: display.stoppageMinute,
      displayTime: display.displayTime,
      scoringTeamId: input.scoringTeamId,
      concedingTeamId: input.concedingTeamId,
      scorerPlayerId: input.scorerPlayerId,
      assistPlayerIds: input.assistPlayerIds,
      ownGoal: input.ownGoal,
    };

    const nextTeams = teams.map((team) => {
      const scored = !input.ownGoal && team.teamId === input.scoringTeamId
        ? team.scored + 1
        : team.scored;
      const conceded = team.teamId === input.concedingTeamId
        ? team.conceded + 1
        : team.conceded;

      return {
        ...team,
        scored,
        conceded,
        updatedAt:
          scored !== team.scored || conceded !== team.conceded
            ? now
            : team.updatedAt,
      };
    });
    const changedTeams = nextTeams.filter((team) => {
      const original = teamsById.get(team.teamId);
      return original ? team.scored !== original.scored || team.conceded !== original.conceded : false;
    });
    const goalSortKey = goalSk(activeThird.third, gameMinute, display.elapsedSeconds, input.eventId);
    const goalEventIdKey = goalEventIdSk(input.eventId);
    const goal = withTimestamps(payload, now, now);
    const existingGoalState = await this.getGoalState(input.gameId, { consistentRead: true });
    const audit = this.buildGoalAuditRecord({
      gameId: input.gameId,
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      action: "goal_created",
      before: null,
      after: goal,
      now,
    });

    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            ...changedTeams.map((team) => {
              const original = teamStatesById.get(team.teamId);
              if (!original) {
                throw new GoalCreationError(
                  "scoreboard_state_changed",
                  409,
                  "Scoreboard changed while creating this goal. Reload the game and try again.",
                );
              }

              return {
                Put: {
                  TableName: this.tableName,
                  Item: buildItemWithTimestamps(
                    gamePk(team.gameId),
                    teamSk(team.teamId),
                    ENTITY_TYPE.gameTeam,
                    {
                      gameId: team.gameId,
                      teamId: team.teamId,
                      name: team.name,
                      color: team.color,
                      scored: team.scored,
                      conceded: team.conceded,
                    },
                    team.createdAt,
                    now,
                  ),
                  ConditionExpression: "#updatedAt = :expectedUpdatedAt AND #data = :expectedData",
                  ExpressionAttributeNames: {
                    "#updatedAt": "updatedAt",
                    "#data": "data",
                  },
                  ExpressionAttributeValues: {
                    ":expectedUpdatedAt": { S: original.record.updatedAt },
                    ":expectedData": { S: original.rawData },
                  },
                },
              };
            }),
            {
              Put: {
                TableName: this.tableName,
                Item: buildItem(
                  gamePk(input.gameId),
                  goalSortKey,
                  ENTITY_TYPE.goal,
                  payload,
                  now,
                ),
                ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: buildItem(
                  gamePk(input.gameId),
                  goalEventIdKey,
                  ENTITY_TYPE.goalEventId,
                  {
                    gameId: input.gameId,
                    eventId: input.eventId,
                    goalSk: goalSortKey,
                  },
                  now,
                ),
                ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            this.buildGoalStateWrite(input.gameId, goal, goalSortKey, now, existingGoalState),
            this.buildGoalAuditPut(audit),
          ],
        }),
      );
    } catch (error) {
      if (!isConditionalWriteFailure(error)) {
        throw error;
      }

      const [existingGoal, existingGoalEventId] = await Promise.all([
        this.getEntity(gamePk(input.gameId), goalSortKey),
        this.getEntity(gamePk(input.gameId), goalEventIdKey),
      ]);
      if (
        existingGoal?.entityType === ENTITY_TYPE.goal ||
        existingGoalEventId?.entityType === ENTITY_TYPE.goalEventId
      ) {
        throw new GoalCreationError(
          "goal_already_created",
          409,
          "Goal event has already been created for this request.",
        );
      }

      throw new GoalCreationError(
        "scoreboard_state_changed",
        409,
        "Scoreboard changed while creating this goal, or goal state changed. Reload the game and try again.",
      );
    }

    const persistedTimeline = await this.listGoalEvents(input.gameId);

    return {
      goal,
      scoreboard: {
        teams: sortGameTeams(nextTeams),
      },
      timeline: persistedTimeline,
    };
  }

  async listGoalEvents(gameId: string): Promise<GoalEventRecord[]> {
    return this.listGoalEventsWithConsistency(gameId, true);
  }

  private async listGoalEventsForWrite(gameId: string): Promise<GoalEventRecord[]> {
    return this.listGoalEventsWithConsistency(gameId, true);
  }

  private async listGoalEventsWithConsistency(
    gameId: string,
    consistentRead: boolean,
  ): Promise<GoalEventRecord[]> {
    requireNonEmpty("gameId", gameId);
    const items = await this.queryByPrefix(gamePk(gameId), "GOAL#", { consistentRead });

    return items
      .filter((item) => item.entityType === ENTITY_TYPE.goal)
      .map((item) =>
        withTimestamps(
          normalizeGoalEventPayload(item.data),
          item.createdAt,
          item.updatedAt,
        ),
      );
  }

  async listGoalAuditEntries(gameId: string): Promise<GoalAuditRecord[]> {
    requireNonEmpty("gameId", gameId);
    const items = await this.queryByPrefix(gamePk(gameId), "AUDIT#GOAL#");

    return items
      .filter((item) => item.entityType === ENTITY_TYPE.goalAudit)
      .map((item) =>
        withTimestamps(
          normalizeGoalAuditPayload(item.data),
          item.createdAt,
          item.updatedAt,
        ),
      );
  }

  async updateGoal(input: UpdateGoalInput): Promise<UpdateGoalResult | null> {
    requireNonEmpty("gameId", input.gameId);
    requireNonEmpty("eventId", input.eventId);
    requireNonEmpty("actorUserId", input.actorUserId);
    const operation = this.normalizeCorrectionOperation(input);
    const replayed = await this.replayGoalCorrectionOperation<UpdateGoalResult>(
      input.gameId,
      operation,
    );
    if (replayed) {
      return replayed;
    }

    const gameItem = await this.getEntity(
      gamePk(input.gameId),
      metadataSk(),
      { consistentRead: true },
    );
    if (!gameItem || gameItem.entityType !== ENTITY_TYPE.game) {
      return null;
    }

    const existing = await this.findGoalByEventId(
      input.gameId,
      input.eventId,
      { consistentRead: true },
    );
    if (!existing) {
      return null;
    }

    const previousGoal = existing.goal;
    const goal = {
      ...previousGoal,
      scoringTeamId:
        input.scoringTeamId === undefined ? previousGoal.scoringTeamId : input.scoringTeamId,
      concedingTeamId: input.concedingTeamId ?? previousGoal.concedingTeamId,
      scorerPlayerId: input.scorerPlayerId ?? previousGoal.scorerPlayerId,
      assistPlayerIds: input.assistPlayerIds ?? previousGoal.assistPlayerIds,
      ownGoal: input.ownGoal ?? previousGoal.ownGoal,
    };
    const { teams, teamStatesById } = await this.readGoalTeamStates(
      input.gameId,
      { consistentRead: true },
    );
    const roster = await this.listGameRoster(input.gameId);
    this.validateGoalRules(goal, teams, roster, "correction");

    const now = this.clock.now();
    const updatedGoal = {
      ...goal,
      updatedAt: now,
    };
    const timeline = await this.listGoalEventsForWrite(input.gameId);
    const nextTimeline = timeline
      .map((entry) => (entry.eventId === input.eventId ? updatedGoal : entry))
      .sort(compareGoalEvents);
    const nextTeams = this.recomputeTeamsFromGoals(input.gameId, teams, nextTimeline, now);
    const latestAfter = latestGoalEvent(nextTimeline);
    const latestGoalSk = latestAfter
      ? goalSk(latestAfter.third, latestAfter.gameMinute, latestAfter.elapsedSeconds, latestAfter.eventId)
      : null;
    const existingGoalState = await this.getGoalState(input.gameId, { consistentRead: true });
    const audit = this.buildGoalAuditRecord({
      gameId: input.gameId,
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      action: "goal_updated",
      before: previousGoal,
      after: updatedGoal,
      now,
    });
    const result: UpdateGoalResult = {
      goal: updatedGoal,
      previousGoal,
      scoreboard: {
        teams: nextTeams,
      },
      timeline: nextTimeline,
      audit,
    };

    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            ...this.buildTeamPutTransactionItems(nextTeams, teamStatesById, now),
            {
              Put: {
                TableName: this.tableName,
                Item: buildItemWithTimestamps(
                  gamePk(input.gameId),
                  existing.sk,
                  ENTITY_TYPE.goal,
                  {
                    gameId: updatedGoal.gameId,
                    eventId: updatedGoal.eventId,
                    third: updatedGoal.third,
                    thirdMinute: updatedGoal.thirdMinute,
                    gameMinute: updatedGoal.gameMinute,
                    elapsedSeconds: updatedGoal.elapsedSeconds,
                    stoppageMinute: updatedGoal.stoppageMinute,
                    displayTime: updatedGoal.displayTime,
                    scoringTeamId: updatedGoal.scoringTeamId,
                    concedingTeamId: updatedGoal.concedingTeamId,
                    scorerPlayerId: updatedGoal.scorerPlayerId,
                    assistPlayerIds: updatedGoal.assistPlayerIds,
                    ownGoal: updatedGoal.ownGoal,
                  },
                  updatedGoal.createdAt,
                  now,
                ),
                ConditionExpression: "#updatedAt = :expectedGoalUpdatedAt AND #data = :expectedGoalData",
                ExpressionAttributeNames: {
                  "#updatedAt": "updatedAt",
                  "#data": "data",
                },
                ExpressionAttributeValues: {
                  ":expectedGoalUpdatedAt": { S: existing.goal.updatedAt },
                  ":expectedGoalData": { S: existing.stored.rawData },
                },
              },
            },
            this.buildGoalStateWrite(input.gameId, latestAfter, latestGoalSk, now, existingGoalState),
            this.buildGoalAuditPut(audit),
            ...(operation
              ? [
                  this.buildGoalCorrectionOperationPut({
                    gameId: input.gameId,
                    eventId: input.eventId,
                    operationId: operation.operationId,
                    requestHash: operation.requestHash,
                    action: "goal_updated",
                    result,
                    now,
                  }),
                ]
              : []),
          ],
        }),
      );
    } catch (error) {
      if (!isConditionalWriteFailure(error)) {
        throw error;
      }

      const replayedAfterConflict =
        await this.replayGoalCorrectionOperation<UpdateGoalResult>(input.gameId, operation);
      if (replayedAfterConflict) {
        return replayedAfterConflict;
      }

      throw new GoalCorrectionError(
        "goal_state_changed",
        409,
        "Goal or scoreboard state changed while updating this goal. Reload the game and try again.",
      );
    }

    return result;
  }

  async deleteGoal(input: DeleteGoalInput): Promise<DeleteGoalResult | null> {
    requireNonEmpty("gameId", input.gameId);
    requireNonEmpty("eventId", input.eventId);
    requireNonEmpty("actorUserId", input.actorUserId);
    const operation = this.normalizeCorrectionOperation(input);
    const replayed = await this.replayGoalCorrectionOperation<DeleteGoalResult>(
      input.gameId,
      operation,
    );
    if (replayed) {
      return replayed;
    }

    const gameItem = await this.getEntity(
      gamePk(input.gameId),
      metadataSk(),
      { consistentRead: true },
    );
    if (!gameItem || gameItem.entityType !== ENTITY_TYPE.game) {
      return null;
    }

    const existing = await this.findGoalByEventId(
      input.gameId,
      input.eventId,
      { consistentRead: true },
    );
    if (!existing) {
      return null;
    }

    const timeline = await this.listGoalEventsForWrite(input.gameId);
    const latestBefore = latestGoalEvent(timeline);
    const existingGoalState = await this.getGoalState(input.gameId, { consistentRead: true });
    if (
      input.expectedLatestEventId &&
      latestBefore?.eventId !== input.expectedLatestEventId
    ) {
      throw new GoalCorrectionError(
        "latest_goal_changed",
        409,
        "Latest goal changed before undo could be applied. Reload the game and try again.",
      );
    }

    if (
      input.expectedLatestEventId &&
      existingGoalState &&
      existingGoalState.state.latestEventId !== input.expectedLatestEventId
    ) {
      throw new GoalCorrectionError(
        "latest_goal_changed",
        409,
        "Latest goal changed before undo could be applied. Reload the game and try again.",
      );
    }

    if (input.action === "goal_undo_last" && latestBefore?.eventId !== input.eventId) {
      throw new GoalCorrectionError(
        "not_latest_goal",
        409,
        "Undo can only delete the current most recent goal.",
      );
    }

    const now = this.clock.now();
    const nextTimeline = timeline
      .filter((entry) => entry.eventId !== input.eventId)
      .sort(compareGoalEvents);
    const { teams, teamStatesById } = await this.readGoalTeamStates(
      input.gameId,
      { consistentRead: true },
    );
    const nextTeams = this.recomputeTeamsFromGoals(input.gameId, teams, nextTimeline, now);
    const latestAfter = latestGoalEvent(nextTimeline);
    const latestGoalSk = latestAfter
      ? goalSk(latestAfter.third, latestAfter.gameMinute, latestAfter.elapsedSeconds, latestAfter.eventId)
      : null;
    const action = input.action ?? "goal_deleted";
    const audit = this.buildGoalAuditRecord({
      gameId: input.gameId,
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      action,
      before: existing.goal,
      after: null,
      now,
    });
    const result: DeleteGoalResult = {
      deletedGoal: existing.goal,
      scoreboard: {
        teams: nextTeams,
      },
      timeline: nextTimeline,
      audit,
    };

    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            ...this.buildTeamPutTransactionItems(nextTeams, teamStatesById, now),
            {
              Delete: {
                TableName: this.tableName,
                Key: {
                  pk: { S: gamePk(input.gameId) },
                  sk: { S: existing.sk },
                },
                ConditionExpression: "#updatedAt = :expectedGoalUpdatedAt AND #data = :expectedGoalData",
                ExpressionAttributeNames: {
                  "#updatedAt": "updatedAt",
                  "#data": "data",
                },
                ExpressionAttributeValues: {
                  ":expectedGoalUpdatedAt": { S: existing.goal.updatedAt },
                  ":expectedGoalData": { S: existing.stored.rawData },
                },
              },
            },
            {
              Delete: {
                TableName: this.tableName,
                Key: {
                  pk: { S: gamePk(input.gameId) },
                  sk: { S: goalEventIdSk(input.eventId) },
                },
              },
            },
            this.buildGoalStateWrite(input.gameId, latestAfter, latestGoalSk, now, existingGoalState),
            this.buildGoalAuditPut(audit),
            ...(operation
              ? [
                  this.buildGoalCorrectionOperationPut({
                    gameId: input.gameId,
                    eventId: input.eventId,
                    operationId: operation.operationId,
                    requestHash: operation.requestHash,
                    action,
                    result,
                    now,
                  }),
                ]
              : []),
          ],
        }),
      );
    } catch (error) {
      if (!isConditionalWriteFailure(error)) {
        throw error;
      }

      const replayedAfterConflict =
        await this.replayGoalCorrectionOperation<DeleteGoalResult>(input.gameId, operation);
      if (replayedAfterConflict) {
        return replayedAfterConflict;
      }

      throw new GoalCorrectionError(
        "goal_state_changed",
        409,
        "Goal or scoreboard state changed while deleting this goal. Reload the game and try again.",
      );
    }

    return result;
  }

  async undoLastGoal(input: UndoLastGoalInput): Promise<DeleteGoalResult | null> {
    requireNonEmpty("gameId", input.gameId);
    requireNonEmpty("actorUserId", input.actorUserId);
    requireNonEmpty("expectedEventId", input.expectedEventId);
    const operation = this.normalizeCorrectionOperation(input);
    const replayed = await this.replayGoalCorrectionOperation<DeleteGoalResult>(
      input.gameId,
      operation,
    );
    if (replayed) {
      return replayed;
    }

    const timeline = await this.listGoalEventsForWrite(input.gameId);
    const latest = latestGoalEvent(timeline);
    if (!latest) {
      return null;
    }

    if (latest.eventId !== input.expectedEventId) {
      throw new GoalCorrectionError(
        "latest_goal_changed",
        409,
        "Latest goal changed before undo could be applied. Reload the game and try again.",
      );
    }

    return this.deleteGoal({
      gameId: input.gameId,
      eventId: latest.eventId,
      actorUserId: input.actorUserId,
      operationId: input.operationId,
      operationRequestHash: input.operationRequestHash,
      action: "goal_undo_last",
      expectedLatestEventId: input.expectedEventId,
    });
  }

  async getIdempotencyRecord(scope: string, key: string): Promise<IdempotencyRecord | null> {
    requireNonEmpty("scope", scope);
    requireNonEmpty("key", key);
    const item = await this.getEntity(idempotencyPk(scope, key), metadataSk());

    if (!item || item.entityType !== ENTITY_TYPE.idempotency) {
      return null;
    }

    return withTimestamps(
      item.data as Omit<IdempotencyRecord, "createdAt" | "updatedAt">,
      item.createdAt,
      item.updatedAt,
    );
  }

  async createIdempotencyRecord(input: CreateIdempotencyRecordInput): Promise<boolean> {
    requireNonEmpty("scope", input.scope);
    requireNonEmpty("key", input.key);
    requireNonEmpty("requestHash", input.requestHash);
    requireNonEmpty("responseBody", input.responseBody);

    if (
      !Number.isInteger(input.responseStatusCode) ||
      input.responseStatusCode < 100 ||
      input.responseStatusCode > 599
    ) {
      throw new Error("responseStatusCode must be a valid HTTP status code.");
    }

    const now = this.clock.now();
    const payload = {
      scope: input.scope,
      key: input.key,
      requestHash: input.requestHash,
      responseStatusCode: input.responseStatusCode,
      responseBody: input.responseBody,
    };

    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: buildItem(
            idempotencyPk(input.scope, input.key),
            metadataSk(),
            ENTITY_TYPE.idempotency,
            payload,
            now,
          ),
          ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        }),
      );
      return true;
    } catch (error) {
      const awsError = error as { name?: string };
      if (awsError.name === "ConditionalCheckFailedException") {
        return false;
      }

      throw error;
    }
  }

  private async putEntity<T>(
    pk: string,
    sk: string,
    entityType: EntityType,
    payload: T,
    now: string,
  ): Promise<void> {
    await this.putEntityWithTimestamps(pk, sk, entityType, payload, now, now);
  }

  private async putEntityWithTimestamps<T>(
    pk: string,
    sk: string,
    entityType: EntityType,
    payload: T,
    createdAt: string,
    updatedAt: string,
  ): Promise<void> {
    await this.client.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: buildItemWithTimestamps(pk, sk, entityType, payload, createdAt, updatedAt),
      }),
    );
  }

  private async putEntityWithTimestampsIfUnchanged<T>(
    pk: string,
    sk: string,
    entityType: EntityType,
    payload: T,
    createdAt: string,
    updatedAt: string,
    expected: { updatedAt: string; rawData: string },
  ): Promise<boolean> {
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: buildItemWithTimestamps(pk, sk, entityType, payload, createdAt, updatedAt),
          ConditionExpression: "#updatedAt = :expectedUpdatedAt AND #data = :expectedData",
          ExpressionAttributeNames: {
            "#updatedAt": "updatedAt",
            "#data": "data",
          },
          ExpressionAttributeValues: {
            ":expectedUpdatedAt": { S: expected.updatedAt },
            ":expectedData": { S: expected.rawData },
          },
        }),
      );
      return true;
    } catch (error) {
      const awsError = error as { name?: string };
      if (awsError.name === "ConditionalCheckFailedException") {
        return false;
      }

      throw error;
    }
  }

  private async deleteEntity(pk: string, sk: string): Promise<void> {
    await this.client.send(
      new DeleteItemCommand({
        TableName: this.tableName,
        Key: {
          pk: { S: pk },
          sk: { S: sk },
        },
      }),
    );
  }

  private async getEntity(
    pk: string,
    sk: string,
    options: { consistentRead?: boolean } = {},
  ): Promise<StoredEntity<unknown> | null> {
    const result = (await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: {
          pk: { S: pk },
          sk: { S: sk },
        },
        ConsistentRead: options.consistentRead,
      }),
    )) as GetItemCommandOutput;

    if (!result.Item) {
      return null;
    }

    return parseStoredEntity(result.Item);
  }

  private async queryByPrefix(
    pk: string,
    skPrefix: string,
    options: QueryByPrefixOptions = {},
  ): Promise<Array<StoredEntity<unknown>>> {
    const result = (await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk and begins_with(sk, :skPrefix)",
        ConsistentRead: options.consistentRead,
        ExpressionAttributeValues: {
          ":pk": { S: pk },
          ":skPrefix": { S: skPrefix },
        },
      }),
    )) as QueryCommandOutput;

    return (result.Items ?? []).map((item) => parseStoredEntity(item));
  }
}
