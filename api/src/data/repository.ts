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
  goalEventIdSk,
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
  GameTeamRecord,
  GamePlayerRecord,
  GameRecord,
  GoalEventRecord,
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

function isThirdStarted(game: Pick<GameRecord, "thirds">): boolean {
  return game.thirds.some((third) => third.startedAt !== null);
}

function compareTeamIds(left: TeamId, right: TeamId): number {
  return TEAM_IDS.indexOf(left) - TEAM_IDS.indexOf(right);
}

function sortGameTeams<T extends { teamId: TeamId }>(teams: T[]): T[] {
  return [...teams].sort((left, right) => compareTeamIds(left.teamId, right.teamId));
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

  async createGoal(input: CreateGoalInput): Promise<CreateGoalResult | null> {
    requireNonEmpty("gameId", input.gameId);
    requireNonEmpty("eventId", input.eventId);
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
        "Scoreboard changed while creating this goal. Reload the game and try again.",
      );
    }

    const goal = withTimestamps(payload, now, now);
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
    requireNonEmpty("gameId", gameId);
    const items = await this.queryByPrefix(gamePk(gameId), "GOAL#", { consistentRead: true });

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

  private async getEntity(pk: string, sk: string): Promise<StoredEntity<unknown> | null> {
    const result = (await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: {
          pk: { S: pk },
          sk: { S: sk },
        },
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
