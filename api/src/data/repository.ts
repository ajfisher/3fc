import {
  GetItemCommand,
  type GetItemCommandOutput,
  PutItemCommand,
  QueryCommand,
  type QueryCommandOutput,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { validateAssistPlayerIds } from "@3fc/contracts";

import {
  aclSk,
  gamePk,
  gameSessionIndexPk,
  gameSessionIndexSk,
  goalSk,
  leaguePk,
  metadataSk,
  playerPk,
  profileSk,
  rosterSk,
  seasonPk,
  seasonSk,
  sessionSk,
  teamSk,
} from "./keys.js";
import type {
  AssignRosterInput,
  CreateGameInput,
  CreateGoalEventInput,
  CreateLeagueInput,
  CreatePlayerInput,
  CreateSeasonInput,
  CreateSessionGameInput,
  CreateSessionInput,
  CreateTeamInput,
  GameRecord,
  GoalEventRecord,
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
  return {
    pk: { S: pk },
    sk: { S: sk },
    entityType: { S: entityType },
    createdAt: { S: now },
    updatedAt: { S: now },
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
    return withTimestamps(payload, now, now);
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
    return withTimestamps(payload, now, now);
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

  private async putEntity<T>(
    pk: string,
    sk: string,
    entityType: EntityType,
    payload: T,
    now: string,
  ): Promise<void> {
    await this.client.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: buildItem(pk, sk, entityType, payload, now),
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
