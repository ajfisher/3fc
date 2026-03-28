import {
  DeleteItemCommand,
  GetItemCommand,
  type GetItemCommandOutput,
  PutItemCommand,
  QueryCommand,
  type QueryCommandOutput,
  ScanCommand,
  type ScanCommandOutput,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { validateAssistPlayerIds } from "@3fc/contracts";

import {
  aclSk,
  gamePk,
  gameSessionIndexPk,
  gameSessionIndexSk,
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
  CreateGameInput,
  CreateGoalEventInput,
  CreateIdempotencyRecordInput,
  CreateLeagueInput,
  CreatePlayerInput,
  CreateSeasonInput,
  CreateSessionGameInput,
  CreateSessionInput,
  CreateTeamInput,
  GameRecord,
  GoalEventRecord,
  IdempotencyRecord,
  LeagueAclRecord,
  LeagueRecord,
  PlayerRecord,
  RosterAssignmentRecord,
  SeasonRecord,
  SessionGameRecord,
  SessionRecord,
  TeamRecord,
  GrantLeagueAccessInput,
} from "./types.js";

const ENTITY_TYPE = {
  league: "league",
  season: "season",
  team: "team",
  session: "session",
  game: "game",
  sessionGame: "sessionGame",
  player: "player",
  acl: "acl",
  roster: "roster",
  goal: "goal",
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

interface StoredEntity<T> {
  pk: string;
  sk: string;
  entityType: EntityType;
  createdAt: string;
  updatedAt: string;
  data: T;
}

class DefaultClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

function requireNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
}

function requireGameMinute(gameMinute: number): void {
  if (!Number.isInteger(gameMinute) || gameMinute < 0) {
    throw new Error("gameMinute must be an integer greater than or equal to zero.");
  }
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

    return withTimestamps(item.data as Omit<GameRecord, "createdAt" | "updatedAt">, item.createdAt, item.updatedAt);
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
  }): Promise<GameRecord | null> {
    requireNonEmpty("gameId", input.gameId);

    if (input.status === undefined && input.gameStartTs === undefined) {
      throw new Error("At least one game field must be updated.");
    }

    const gameItem = await this.getEntity(gamePk(input.gameId), metadataSk());
    if (!gameItem || gameItem.entityType !== ENTITY_TYPE.game) {
      return null;
    }

    const existing = gameItem.data as Omit<GameRecord, "createdAt" | "updatedAt">;
    const nextGameStartTs = input.gameStartTs ?? existing.gameStartTs;
    const nextStatus = input.status ?? existing.status;

    const updatedPayload = {
      ...existing,
      gameStartTs: nextGameStartTs,
      status: nextStatus,
    };

    const now = this.clock.now();

    await this.putEntityWithTimestamps(
      gamePk(existing.gameId),
      metadataSk(),
      ENTITY_TYPE.game,
      updatedPayload,
      gameItem.createdAt,
      now,
    );

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

  async deleteGame(gameId: string): Promise<boolean> {
    requireNonEmpty("gameId", gameId);

    const gameItem = await this.getEntity(gamePk(gameId), metadataSk());
    if (!gameItem || gameItem.entityType !== ENTITY_TYPE.game) {
      return false;
    }

    const game = gameItem.data as Omit<GameRecord, "createdAt" | "updatedAt">;

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

    const now = this.clock.now();
    const payload = {
      gameId: input.gameId,
      teamId: input.teamId,
      playerId: input.playerId,
    };

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

  async createGoalEvent(input: CreateGoalEventInput): Promise<GoalEventRecord> {
    requireNonEmpty("gameId", input.gameId);
    requireNonEmpty("eventId", input.eventId);
    requireNonEmpty("scorerPlayerId", input.scorerPlayerId);
    requireGameMinute(input.gameMinute);

    validateAssistPlayerIds(input.scorerPlayerId, input.assistPlayerIds);

    if (input.ownGoal && input.scoringTeamId !== null) {
      throw new Error("ownGoal=true requires scoringTeamId to be null.");
    }

    if (!input.ownGoal && input.scoringTeamId === null) {
      throw new Error("scoringTeamId is required when ownGoal=false.");
    }

    const now = this.clock.now();
    const payload = {
      gameId: input.gameId,
      eventId: input.eventId,
      third: input.third,
      gameMinute: input.gameMinute,
      scoringTeamId: input.scoringTeamId,
      concedingTeamId: input.concedingTeamId,
      scorerPlayerId: input.scorerPlayerId,
      assistPlayerIds: input.assistPlayerIds,
      ownGoal: input.ownGoal,
    };

    await this.putEntity(
      gamePk(input.gameId),
      goalSk(input.third, input.gameMinute, input.eventId),
      ENTITY_TYPE.goal,
      payload,
      now,
    );
    return withTimestamps(payload, now, now);
  }

  async listGoalEvents(gameId: string): Promise<GoalEventRecord[]> {
    requireNonEmpty("gameId", gameId);
    const items = await this.queryByPrefix(gamePk(gameId), "GOAL#");

    return items
      .filter((item) => item.entityType === ENTITY_TYPE.goal)
      .map((item) =>
        withTimestamps(
          item.data as Omit<GoalEventRecord, "createdAt" | "updatedAt">,
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

  private async queryByPrefix(pk: string, skPrefix: string): Promise<Array<StoredEntity<unknown>>> {
    const result = (await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk and begins_with(sk, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": { S: pk },
          ":skPrefix": { S: skPrefix },
        },
      }),
    )) as QueryCommandOutput;

    return (result.Items ?? []).map((item) => parseStoredEntity(item));
  }
}
