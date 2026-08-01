import assert from "node:assert/strict";
import test from "node:test";

import {
  DeleteItemCommand,
  GetItemCommand,
  ScanCommand,
  type AttributeValue,
  PutItemCommand,
  QueryCommand,
  TransactWriteItemsCommand,
} from "@aws-sdk/client-dynamodb";
import {
  createDefaultThirdTimerSegments,
  DEFAULT_THIRD_LENGTH_MINUTES,
  formatThirdDisplayTime,
  type TeamId,
} from "@3fc/contracts";

import {
  buildJoinCodeForGameId,
  GameAlreadyExistsError,
  GameJoinCodeCollisionError,
  GameJoinRegistrationError,
  GameMutationStateError,
  GameTimerTransitionError,
  PlayerClaimError,
  ThreeFcRepository,
} from "../data/repository.js";

type Item = Record<string, AttributeValue>;

interface ObservedQuery {
  pk: string;
  skPrefix: string;
  consistentRead?: boolean;
}

class InMemoryDynamoClient {
  private readonly items = new Map<string, Item>();
  private readonly queries: ObservedQuery[] = [];
  private beforeNextPut: (() => void) | null = null;
  readonly getItemRequests: Array<{ pk: string; sk: string; consistentRead: boolean }> = [];

  seedItem(item: Item): void {
    const pk = this.readString(item.pk, "pk");
    const sk = this.readString(item.sk, "sk");
    this.items.set(`${pk}|${sk}`, item);
  }

  readItem(pk: string, sk: string): Item | undefined {
    return this.items.get(`${pk}|${sk}`);
  }

  readQueries(): readonly ObservedQuery[] {
    return this.queries;
  }

  runBeforeNextPut(callback: () => void): void {
    this.beforeNextPut = callback;
  }

  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutItemCommand) {
      const item = command.input.Item;
      if (!item) {
        throw new Error("PutItemCommand is missing Item.");
      }

      const pk = this.readString(item.pk, "pk");
      const sk = this.readString(item.sk, "sk");
      const id = `${pk}|${sk}`;

      if (this.beforeNextPut) {
        const callback = this.beforeNextPut;
        this.beforeNextPut = null;
        callback();
      }

      if (
        command.input.ConditionExpression &&
        !this.conditionMatches(
        command.input.ConditionExpression,
          this.items.get(id),
          command.input.ExpressionAttributeNames ?? {},
          command.input.ExpressionAttributeValues ?? {},
        )
      ) {
        const error = new Error("Conditional request failed.");
        (error as Error & { name: string }).name = "ConditionalCheckFailedException";
        throw error;
      }

      this.items.set(id, item);
      return {};
    }

    if (command instanceof GetItemCommand) {
      const key = command.input.Key;
      if (!key) {
        throw new Error("GetItemCommand is missing Key.");
      }

      const pk = this.readString(key.pk, "pk");
      const sk = this.readString(key.sk, "sk");
      this.getItemRequests.push({
        pk,
        sk,
        consistentRead: command.input.ConsistentRead === true,
      });
      const item = this.items.get(`${pk}|${sk}`);
      return { Item: item };
    }

    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues ?? {};
      const pk = this.readString(values[":pk"], ":pk");
      const prefix = this.readString(values[":skPrefix"], ":skPrefix");
      this.queries.push({
        pk,
        skPrefix: prefix,
        consistentRead: command.input.ConsistentRead,
      });

      const items = [...this.items.values()]
        .filter((item) => this.readString(item.pk, "pk") === pk)
        .filter((item) => this.readString(item.sk, "sk").startsWith(prefix))
        .sort((left, right) =>
          this.readString(left.sk, "sk").localeCompare(this.readString(right.sk, "sk")),
        );

      return { Items: items };
    }

    if (command instanceof ScanCommand) {
      return { Items: [...this.items.values()] };
    }

    if (command instanceof DeleteItemCommand) {
      const key = command.input.Key;
      if (!key) {
        throw new Error("DeleteItemCommand is missing Key.");
      }

      const pk = this.readString(key.pk, "pk");
      const sk = this.readString(key.sk, "sk");
      this.items.delete(`${pk}|${sk}`);
      return {};
    }

    if (command instanceof TransactWriteItemsCommand) {
      const writes = command.input.TransactItems ?? [];

      for (const write of writes) {
        if (!write.Put && !write.Delete && !write.ConditionCheck) {
          throw new Error("Test client only supports Put, Delete, and ConditionCheck transaction items.");
        }
      }

      if (this.beforeNextPut) {
        const callback = this.beforeNextPut;
        this.beforeNextPut = null;
        callback();
      }

      const throwConditionalCancellation = (failedWrite: (typeof writes)[number]): never => {
        const error = new Error("Conditional transaction request failed.");
        (
          error as Error & {
            name: string;
            CancellationReasons: Array<{ Code: string }>;
          }
        ).name = "TransactionCanceledException";
        (
          error as Error & {
            name: string;
            CancellationReasons: Array<{ Code: string }>;
          }
        ).CancellationReasons = writes.map((write) => ({
          Code: write === failedWrite ? "ConditionalCheckFailed" : "None",
        }));
        throw error;
      };

      for (const write of writes) {
        if (write.Put) {
          const item = write.Put.Item;
          if (!item) {
            throw new Error("TransactWriteItemsCommand Put is missing Item.");
          }

          const pk = this.readString(item.pk, "pk");
          const sk = this.readString(item.sk, "sk");
          const id = `${pk}|${sk}`;

          if (
            write.Put.ConditionExpression &&
            !this.conditionMatches(
              write.Put.ConditionExpression,
              this.items.get(id),
              write.Put.ExpressionAttributeNames ?? {},
              write.Put.ExpressionAttributeValues ?? {},
            )
          ) {
            throwConditionalCancellation(write);
          }
        }

        if (write.Delete) {
          const key = write.Delete.Key;
          if (!key) {
            throw new Error("TransactWriteItemsCommand Delete is missing Key.");
          }

          const pk = this.readString(key.pk, "pk");
          const sk = this.readString(key.sk, "sk");
          const id = `${pk}|${sk}`;

          if (
            write.Delete.ConditionExpression &&
            !this.conditionMatches(
              write.Delete.ConditionExpression,
              this.items.get(id),
              write.Delete.ExpressionAttributeNames ?? {},
              write.Delete.ExpressionAttributeValues ?? {},
            )
          ) {
            throwConditionalCancellation(write);
          }
        }

        if (write.ConditionCheck) {
          const key = write.ConditionCheck.Key;
          if (!key) {
            throw new Error("TransactWriteItemsCommand ConditionCheck is missing Key.");
          }

          const pk = this.readString(key.pk, "pk");
          const sk = this.readString(key.sk, "sk");
          const id = `${pk}|${sk}`;

          if (
            write.ConditionCheck.ConditionExpression &&
            !this.conditionMatches(
              write.ConditionCheck.ConditionExpression,
              this.items.get(id),
              write.ConditionCheck.ExpressionAttributeNames ?? {},
              write.ConditionCheck.ExpressionAttributeValues ?? {},
            )
          ) {
            throwConditionalCancellation(write);
          }
        }
      }

      for (const write of writes) {
        if (write.Put) {
          const item = write.Put.Item;
          if (!item) {
            throw new Error("TransactWriteItemsCommand Put is missing Item.");
          }

          const pk = this.readString(item.pk, "pk");
          const sk = this.readString(item.sk, "sk");
          this.items.set(`${pk}|${sk}`, item);
        }

        if (write.Delete) {
          const key = write.Delete.Key;
          if (!key) {
            throw new Error("TransactWriteItemsCommand Delete is missing Key.");
          }

          const pk = this.readString(key.pk, "pk");
          const sk = this.readString(key.sk, "sk");
          this.items.delete(`${pk}|${sk}`);
        }
      }

      return {};
    }

    throw new Error(`Unsupported command: ${(command as { constructor?: { name?: string } }).constructor?.name ?? "unknown"}`);
  }

  private readString(value: AttributeValue | undefined, name: string): string {
    if (!value || value.S === undefined) {
      throw new Error(`Missing string attribute ${name}`);
    }

    return value.S;
  }

  private conditionMatches(
    expression: string,
    existing: Item | undefined,
    attributeNames: Record<string, string>,
    attributeValues: Record<string, AttributeValue>,
  ): boolean {
    return expression.split(/\s+AND\s+/).every((clause) => {
      const attributeNotExists = clause.match(/^attribute_not_exists\(([^)]+)\)$/);
      if (attributeNotExists) {
        const attributeName = this.resolveAttributeName(attributeNotExists[1], attributeNames);
        return !existing || existing[attributeName] === undefined;
      }

      const equality = clause.match(/^(.+?)\s*=\s*(.+)$/);
      if (equality) {
        const attributeName = this.resolveAttributeName(equality[1], attributeNames);
        const expected = attributeValues[equality[2].trim()];
        const actual = existing?.[attributeName];
        return this.attributeValueEquals(actual, expected);
      }

      throw new Error(`Unsupported condition expression in test client: ${expression}`);
    });
  }

  private resolveAttributeName(value: string, attributeNames: Record<string, string>): string {
    const trimmed = value.trim();
    return attributeNames[trimmed] ?? trimmed;
  }

  private attributeValueEquals(left: AttributeValue | undefined, right: AttributeValue | undefined): boolean {
    if (!left || !right) {
      return false;
    }

    return JSON.stringify(left) === JSON.stringify(right);
  }
}

class IncrementingClock {
  private offset = 0;

  now(): string {
    const stamp = new Date(Date.UTC(2026, 1, 22, 0, 0, this.offset));
    this.offset += 1;
    return stamp.toISOString();
  }
}

class MutableClock {
  constructor(private stamp: string) {}

  set(stamp: string): void {
    this.stamp = stamp;
  }

  now(): string {
    return this.stamp;
  }
}

function createRepository(): ThreeFcRepository {
  return new ThreeFcRepository(new InMemoryDynamoClient(), "threefc_test", new IncrementingClock());
}

function createRepositoryHarness(): { repository: ThreeFcRepository; client: InMemoryDynamoClient } {
  const client = new InMemoryDynamoClient();
  return {
    client,
    repository: new ThreeFcRepository(client, "threefc_test", new IncrementingClock()),
  };
}

function markStoredGameFinished(client: InMemoryDynamoClient, gameId: string): void {
  const item = client.readItem(`GAME#${gameId}`, "METADATA");
  assert.ok(item);
  const rawData = item.data?.S;
  if (typeof rawData !== "string") {
    throw new Error("Stored game metadata is missing JSON data.");
  }
  const data = JSON.parse(rawData) as Record<string, unknown>;
  item.data = {
    S: JSON.stringify({
      ...data,
      status: "finished",
      finishedAt: "2026-02-23T00:00:59.000Z",
    }),
  };
  item.updatedAt = { S: "2026-02-23T00:00:59.000Z" };
  client.seedItem(item);
}

function seedStoredGameTeam(
  client: InMemoryDynamoClient,
  input: {
    gameId: string;
    teamId: TeamId;
    name: string;
    color: string | null;
    scored: number;
    conceded: number;
    createdAt: string;
    updatedAt: string;
  },
): void {
  client.seedItem({
    pk: { S: `GAME#${input.gameId}` },
    sk: { S: `TEAM#${input.teamId}` },
    entityType: { S: "gameTeam" },
    createdAt: { S: input.createdAt },
    updatedAt: { S: input.updatedAt },
    data: {
      S: JSON.stringify({
        gameId: input.gameId,
        teamId: input.teamId,
        name: input.name,
        color: input.color,
        scored: input.scored,
        conceded: input.conceded,
      }),
    },
  });
}

function seedStoredSeasonTeam(
  client: InMemoryDynamoClient,
  input: {
    seasonId: string;
    teamId: TeamId;
    name: string;
    color: string | null;
    createdAt: string;
    updatedAt: string;
  },
): void {
  client.seedItem({
    pk: { S: `SEASON#${input.seasonId}` },
    sk: { S: `TEAM#${input.teamId}` },
    entityType: { S: "team" },
    createdAt: { S: input.createdAt },
    updatedAt: { S: input.updatedAt },
    data: {
      S: JSON.stringify({
        seasonId: input.seasonId,
        teamId: input.teamId,
        name: input.name,
        color: input.color,
      }),
    },
  });
}

test("repository supports round-trip create/read for core entities", async () => {
  const repository = createRepository();

  const league = await repository.createLeague({
    leagueId: "league-1",
    name: "Three FC",
    slug: "three-fc",
    createdByUserId: "user-admin",
  });
  const readLeague = await repository.getLeague("league-1");
  assert.deepEqual(readLeague, league);

  const season = await repository.createSeason({
    leagueId: "league-1",
    seasonId: "2026",
    name: "2026 Season",
    slug: "2026",
  });
  assert.deepEqual(await repository.getSeason("2026"), season);
  assert.deepEqual(await repository.listSeasonsForLeague("league-1"), [season]);

  const team = await repository.createTeam({
    seasonId: "2026",
    teamId: "red",
    name: "Red",
    color: "#ff0000",
  });
  assert.deepEqual(await repository.listTeamsForSeason("2026"), [team]);

  const session = await repository.createSession({
    seasonId: "2026",
    sessionId: "20260222",
    sessionDate: "2026-02-22",
  });
  assert.deepEqual(await repository.getSession("20260222"), session);
  assert.deepEqual(await repository.listSessionsForSeason("2026"), [session]);

  const game = await repository.createGame({
    gameId: "game-1",
    leagueId: "league-1",
    seasonId: "2026",
    sessionId: "20260222",
    status: "scheduled",
    gameStartTs: "2026-02-22T10:00:00Z",
  });
  assert.deepEqual(await repository.getGame("game-1"), game);
  assert.match(game.joinCode, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  assert.deepEqual(await repository.getGameByJoinCode(game.joinCode), game);
  assert.deepEqual(await repository.getGameByJoinCode(game.joinCode.toLowerCase()), game);

  const gameTeam = await repository.createGameTeamOverride({
    gameId: "game-1",
    teamId: "red",
    name: "Game Red",
    color: "#d83b36",
  });
  assert.deepEqual(await repository.listTeamsForGame("game-1"), [gameTeam]);

  const player = await repository.createPlayer({
    playerId: "player-1",
    nickname: "AJ",
  });
  assert.deepEqual(await repository.getPlayer("player-1"), player);
  assert.deepEqual(await repository.listPlayers({ search: "aj" }), [player]);

  const gamePlayer = await repository.linkGamePlayer({
    gameId: "game-1",
    playerId: "player-1",
  });
  assert.deepEqual(await repository.listGamePlayers("game-1"), [gamePlayer]);

  const joinResult = await repository.joinGameByCode({
    joinCode: game.joinCode.toLowerCase(),
    playerId: "player-join",
    nickname: "Nia",
  });
  assert.ok(joinResult);
  assert.equal(joinResult.game.gameId, "game-1");
  assert.deepEqual(await repository.getPlayer("player-join"), joinResult.player);
  assert.deepEqual(await repository.listGamePlayers("game-1"), [gamePlayer, joinResult.link]);

  const accessGrant = await repository.grantLeagueAccess({
    leagueId: "league-1",
    userId: "user-scorekeeper",
    role: "scorekeeper",
    grantedByUserId: "user-admin",
  });
  const leagueAccess = await repository.listLeagueAccess("league-1");
  assert.equal(leagueAccess.length, 2);
  assert.equal(leagueAccess[0].userId, "user-admin");
  assert.equal(leagueAccess[0].role, "admin");
  assert.equal(leagueAccess[1].userId, "user-scorekeeper");
  assert.deepEqual(leagueAccess[1], accessGrant);
  assert.deepEqual(await repository.getLeagueAccess("league-1", "user-admin"), leagueAccess[0]);

  const rosterAssignment = await repository.assignRosterPlayer({
    gameId: "game-1",
    teamId: "red",
    playerId: "player-1",
  });
  assert.deepEqual(await repository.listGameRoster("game-1"), [rosterAssignment]);
  assert.equal((await repository.listGamePlayers("game-1")).length, 2);

  const reassignedRoster = await repository.assignRosterPlayer({
    gameId: "game-1",
    teamId: "blue",
    playerId: "player-1",
  });
  assert.deepEqual(await repository.listGameRoster("game-1"), [reassignedRoster]);
  assert.equal(reassignedRoster.teamId, "blue");
});

test("repository claims players idempotently for one user and rejects another user", async () => {
  const { repository, client } = createRepositoryHarness();

  await repository.createPlayer({
    playerId: "player-claim",
    nickname: "Claim Me",
  });

  const claimed = await repository.claimPlayer({
    playerId: "player-claim",
    userId: "delegate@example.com",
  });
  assert.equal(claimed?.claimedByUserId, "delegate@example.com");
  const claimItem = client.readItem("USER#delegate@example.com", "PLAYER#player-claim");
  assert.equal(claimItem?.entityType?.S, "playerClaim");
  assert.equal(claimItem?.data?.S, JSON.stringify({
    userId: "delegate@example.com",
    playerId: "player-claim",
  }));

  const replayed = await repository.claimPlayer({
    playerId: "player-claim",
    userId: "delegate@example.com",
  });
  assert.deepEqual(replayed, claimed);

  await assert.rejects(
    repository.claimPlayer({
      playerId: "player-claim",
      userId: "other@example.com",
    }),
    (error: unknown) =>
      error instanceof PlayerClaimError &&
      error.code === "player_already_claimed" &&
      error.statusCode === 409,
  );
});

test("repository rejects creating games directly as finished", async () => {
  const repository = createRepository();

  await assert.rejects(
    repository.createGame({
      gameId: "game-finished",
      leagueId: "league-1",
      seasonId: "season-1",
      sessionId: "session-1",
      status: "finished",
      gameStartTs: "2026-02-22T10:00:00Z",
    }),
    (error: unknown) =>
      error instanceof GameTimerTransitionError &&
      error.code === "invalid_status_transition" &&
      /cannot be created directly as finished/.test(error.message),
  );
});

test("repository rejects duplicate join code lookup records", async () => {
  const repository = createRepository();

  await repository.createGame({
    gameId: "game-join-a",
    joinCode: "SHARED23",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    gameStartTs: "2026-02-22T10:00:00Z",
  });

  await assert.rejects(
    repository.createGame({
      gameId: "game-join-b",
      joinCode: "SHARED23",
      leagueId: "league-1",
      seasonId: "season-1",
      sessionId: "session-1",
      gameStartTs: "2026-02-22T11:00:00Z",
    }),
    GameJoinCodeCollisionError,
  );
  assert.equal(await repository.getGame("game-join-b"), null);
});

test("repository rejects custom join codes that do not match the public contract", async () => {
  const repository = createRepository();

  await assert.rejects(
    repository.createGame({
      gameId: "game-invalid-join-code",
      joinCode: "STRONG01",
      leagueId: "league-1",
      seasonId: "season-1",
      sessionId: "session-1",
      gameStartTs: "2026-02-22T10:00:00Z",
    }),
    /joinCode must be 8 uppercase non-ambiguous letters or digits/,
  );
  assert.equal(await repository.getGame("game-invalid-join-code"), null);
});

test("repository distinguishes duplicate game IDs from join-code collisions", async () => {
  const repository = createRepository();

  await repository.createGame({
    gameId: "game-existing",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    gameStartTs: "2026-02-22T10:00:00Z",
  });

  await assert.rejects(
    repository.createGame({
      gameId: "game-existing",
      leagueId: "league-1",
      seasonId: "season-1",
      sessionId: "session-1",
      gameStartTs: "2026-02-22T11:00:00Z",
    }),
    GameAlreadyExistsError,
  );
});

test("repository rethrows non-conditional transaction cancellation when creating games", async () => {
  const { repository, client } = createRepositoryHarness();

  client.runBeforeNextPut(() => {
    const error = new Error("Create game transaction validation failed.");
    (
      error as Error & {
        name: string;
        CancellationReasons: Array<{ Code: string }>;
      }
    ).name = "TransactionCanceledException";
    (
      error as Error & {
        name: string;
        CancellationReasons: Array<{ Code: string }>;
      }
    ).CancellationReasons = [{ Code: "ValidationError" }];
    throw error;
  });

  await assert.rejects(
    repository.createGame({
      gameId: "game-create-cancelled",
      leagueId: "league-1",
      seasonId: "season-1",
      sessionId: "session-1",
      gameStartTs: "2026-02-22T11:00:00Z",
    }),
    /Create game transaction validation failed/,
  );
  assert.equal(await repository.getGame("game-create-cancelled"), null);
});

test("repository strongly reads game join-code lookups", async () => {
  const { repository, client } = createRepositoryHarness();

  const game = await repository.createGame({
    gameId: "game-join-strong",
    joinCode: "STRNG234",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    gameStartTs: "2026-02-22T10:00:00Z",
  });
  client.getItemRequests.length = 0;

  assert.deepEqual(await repository.getGameByJoinCode("strng234"), game);
  assert.deepEqual(
    client.getItemRequests.map((request) => request.consistentRead),
    [true, true],
  );
});

test("repository query supports deterministic session->games ordering", async () => {
  const repository = createRepository();

  await repository.createSessionGame({
    sessionId: "session-a",
    gameId: "game-late",
    gameStartTs: "2026-02-22T12:00:00Z",
    leagueId: "league-1",
    seasonId: "2026",
  });
  await repository.createSessionGame({
    sessionId: "session-a",
    gameId: "game-early",
    gameStartTs: "2026-02-22T09:00:00Z",
    leagueId: "league-1",
    seasonId: "2026",
  });

  const games = await repository.listGamesForSession("session-a");
  assert.equal(games.length, 2);
  assert.equal(games[0].gameId, "game-early");
  assert.equal(games[1].gameId, "game-late");
});

test("repository query supports deterministic game timeline ordering", async () => {
  const { repository, client } = createRepositoryHarness();

  for (const goal of [
    {
      eventId: "goal-3",
      sk: "GOAL#2#0030#0000550#goal-3",
      third: 2,
      thirdMinute: 10,
      gameMinute: 30,
      elapsedSeconds: 550,
      displayTime: "09:10",
      scoringTeamId: "yellow",
      concedingTeamId: "blue",
      scorerPlayerId: "player-3",
      assistPlayerIds: [],
      ownGoal: false,
    },
    {
      eventId: "goal-1",
      sk: "GOAL#1#0002#0000070#goal-1",
      third: 1,
      thirdMinute: 2,
      gameMinute: 2,
      elapsedSeconds: 70,
      displayTime: "01:10",
      scoringTeamId: "red",
      concedingTeamId: "yellow",
      scorerPlayerId: "player-1",
      assistPlayerIds: [],
      ownGoal: false,
    },
    {
      eventId: "goal-2",
      sk: "GOAL#1#0008#0000430#goal-2",
      third: 1,
      thirdMinute: 8,
      gameMinute: 8,
      elapsedSeconds: 430,
      displayTime: "07:10",
      scoringTeamId: "blue",
      concedingTeamId: "red",
      scorerPlayerId: "player-2",
      assistPlayerIds: ["player-4"],
      ownGoal: false,
    },
  ] as const) {
    client.seedItem({
      pk: { S: "GAME#game-1" },
      sk: { S: goal.sk },
      entityType: { S: "goal" },
      createdAt: { S: "2026-02-22T00:00:00.000Z" },
      updatedAt: { S: "2026-02-22T00:00:00.000Z" },
      data: {
        S: JSON.stringify({
          gameId: "game-1",
          eventId: goal.eventId,
          third: goal.third,
          thirdMinute: goal.thirdMinute,
          gameMinute: goal.gameMinute,
          elapsedSeconds: goal.elapsedSeconds,
          stoppageMinute: null,
          displayTime: goal.displayTime,
          scoringTeamId: goal.scoringTeamId,
          concedingTeamId: goal.concedingTeamId,
          scorerPlayerId: goal.scorerPlayerId,
          assistPlayerIds: goal.assistPlayerIds,
          ownGoal: goal.ownGoal,
        }),
      },
    });
  }

  const timeline = await repository.listGoalEvents("game-1");
  assert.equal(timeline.length, 3);
  assert.deepEqual(
    timeline.map((goal) => goal.eventId),
    ["goal-1", "goal-2", "goal-3"],
  );
});

test("repository orders stoppage goals by elapsed time before event ID", async () => {
  const { repository, client } = createRepositoryHarness();

  for (const goal of [
    {
      eventId: "goal-z-later",
      sk: "GOAL#1#0020#0001265#goal-z-later",
      elapsedSeconds: 1265,
      stoppageMinute: 2,
      displayTime: "20+02",
    },
    {
      eventId: "goal-a-earlier",
      sk: "GOAL#1#0020#0001205#goal-a-earlier",
      elapsedSeconds: 1205,
      stoppageMinute: 1,
      displayTime: "20+01",
    },
  ] as const) {
    client.seedItem({
      pk: { S: "GAME#game-1" },
      sk: { S: goal.sk },
      entityType: { S: "goal" },
      createdAt: { S: "2026-02-22T00:00:00.000Z" },
      updatedAt: { S: "2026-02-22T00:00:00.000Z" },
      data: {
        S: JSON.stringify({
          gameId: "game-1",
          eventId: goal.eventId,
          third: 1,
          thirdMinute: 20,
          gameMinute: 20,
          elapsedSeconds: goal.elapsedSeconds,
          stoppageMinute: goal.stoppageMinute,
          displayTime: goal.displayTime,
          scoringTeamId: "red",
          concedingTeamId: "blue",
          scorerPlayerId: "player-red",
          assistPlayerIds: [],
          ownGoal: false,
        }),
      },
    });
  }

  const timeline = await repository.listGoalEvents("game-1");
  assert.deepEqual(
    timeline.map((goal) => goal.eventId),
    ["goal-a-earlier", "goal-z-later"],
  );
});

test("repository uses creation order to break same-second goal ties", async () => {
  const clock = new MutableClock("2026-02-22T00:00:00.000Z");
  const repository = new ThreeFcRepository(
    new InMemoryDynamoClient(),
    "threefc_test",
    clock,
  );
  await setupScoringGame(repository);
  clock.set("2026-02-22T00:00:00.000Z");
  await repository.startGameThird({ gameId: "game-1", third: 1 });

  clock.set("2026-02-22T00:00:10.100Z");
  await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-z-earlier",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-red",
    assistPlayerIds: [],
    ownGoal: false,
  });
  clock.set("2026-02-22T00:00:10.900Z");
  await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-a-later",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: "yellow",
    concedingTeamId: "red",
    scorerPlayerId: "player-yellow",
    assistPlayerIds: [],
    ownGoal: false,
  });

  assert.deepEqual((await repository.listGoalEvents("game-1")).map((goal) => goal.eventId), [
    "goal-z-earlier",
    "goal-a-later",
  ]);
  await assert.rejects(
    repository.undoLastGoal({
      gameId: "game-1",
      actorUserId: "scorekeeper@example.com",
      expectedEventId: "goal-z-earlier",
    }),
    /Latest goal changed/,
  );

  const result = await repository.undoLastGoal({
    gameId: "game-1",
    actorUserId: "scorekeeper@example.com",
    expectedEventId: "goal-a-later",
  });

  assert.ok(result);
  assert.equal(result.deletedGoal.eventId, "goal-a-later");
  assert.deepEqual(result.timeline.map((goal) => goal.eventId), ["goal-z-earlier"]);
});

test("repository normalizes partial legacy goal records to documented response bounds", async () => {
  const { repository, client } = createRepositoryHarness();

  client.seedItem({
    pk: { S: "GAME#game-1" },
    sk: { S: "GOAL#1#0000#0000000#goal-legacy" },
    entityType: { S: "goal" },
    createdAt: { S: "2026-02-22T00:00:00.000Z" },
    updatedAt: { S: "2026-02-22T00:00:00.000Z" },
    data: {
      S: JSON.stringify({
        gameId: "game-1",
        eventId: "goal-legacy",
        third: 9,
        elapsedSeconds: 0,
        stoppageMinute: 0,
        scoringTeamId: "green",
        concedingTeamId: "orange",
        scorerPlayerId: "player-red",
        assistPlayerIds: [],
        ownGoal: false,
      }),
    },
  });

  const [goal] = await repository.listGoalEvents("game-1");
  assert.equal(goal.third, 1);
  assert.equal(goal.thirdMinute, 1);
  assert.equal(goal.gameMinute, 1);
  assert.equal(goal.stoppageMinute, null);
  assert.equal(goal.scoringTeamId, null);
  assert.equal(goal.concedingTeamId, "red");
});

test("repository normalizes malformed game team records to documented response bounds", async () => {
  const { repository, client } = createRepositoryHarness();

  client.seedItem({
    pk: { S: "GAME#game-legacy" },
    sk: { S: "TEAM#green" },
    entityType: { S: "gameTeam" },
    createdAt: { S: "2026-02-22T00:00:00.000Z" },
    updatedAt: { S: "2026-02-22T00:00:00.000Z" },
    data: {
      S: JSON.stringify({
        gameId: "game-legacy",
        teamId: "green",
        name: 42,
        color: 99,
        scored: -1,
        conceded: -2,
      }),
    },
  });

  const [team] = await repository.listTeamsForGame("game-legacy");
  assert.equal(team.teamId, "red");
  assert.equal(team.name, "");
  assert.equal(team.color, null);
  assert.equal(team.scored, 0);
  assert.equal(team.conceded, 0);
});

test("repository supports league discovery by user ACL", async () => {
  const repository = createRepository();

  await repository.createLeague({
    leagueId: "league-1",
    name: "League One",
    slug: "league-one",
    createdByUserId: "admin@example.com",
  });
  await repository.createLeague({
    leagueId: "league-2",
    name: "League Two",
    slug: "league-two",
    createdByUserId: "other@example.com",
  });
  await repository.grantLeagueAccess({
    leagueId: "league-2",
    userId: "admin@example.com",
    role: "scorekeeper",
    grantedByUserId: "other@example.com",
  });

  const leagues = await repository.listLeaguesForUser("admin@example.com");
  assert.equal(leagues.length, 2);
  assert.deepEqual(
    leagues.map((league) => league.leagueId),
    ["league-1", "league-2"],
  );
});

test("repository league discovery ignores non-entity auth records in table scans", async () => {
  const { repository, client } = createRepositoryHarness();

  await repository.createLeague({
    leagueId: "league-1",
    name: "League One",
    slug: "league-one",
    createdByUserId: "admin@example.com",
  });

  client.seedItem({
    pk: { S: "AUTH_SESSION#session-1" },
    sk: { S: "METADATA" },
    entityType: { S: "session" },
    email: { S: "admin@example.com" },
    createdAt: { S: "2026-02-22T00:00:00.000Z" },
    updatedAt: { S: "2026-02-22T00:00:00.000Z" },
    expiresAtEpoch: { N: "1770000000" },
  });

  const leagues = await repository.listLeaguesForUser("admin@example.com");
  assert.equal(leagues.length, 1);
  assert.equal(leagues[0].leagueId, "league-1");
});

test("repository supports update and delete of games", async () => {
  const repository = createRepository();

  await repository.createLeague({
    leagueId: "league-1",
    name: "Three FC",
    createdByUserId: "admin@example.com",
  });
  await repository.createSeason({
    leagueId: "league-1",
    seasonId: "season-1",
    name: "Season One",
  });
  await repository.createSession({
    seasonId: "season-1",
    sessionId: "20260222",
    sessionDate: "2026-02-22",
  });
  await repository.createGame({
    gameId: "game-1",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "20260222",
    status: "scheduled",
    gameStartTs: "2026-02-22T10:00:00Z",
  });
  await repository.createSessionGame({
    sessionId: "20260222",
    gameId: "game-1",
    gameStartTs: "2026-02-22T10:00:00Z",
    leagueId: "league-1",
    seasonId: "season-1",
  });

  const updated = await repository.updateGame({
    gameId: "game-1",
    status: "live",
    gameStartTs: "2026-02-22T11:00:00Z",
  });
  assert.equal(updated?.status, "live");
  assert.equal(updated?.gameStartTs, "2026-02-22T11:00:00Z");

  const listed = await repository.listGamesForSeason("season-1");
  assert.equal(listed.length, 1);
  assert.equal(listed[0].gameStartTs, "2026-02-22T11:00:00Z");

  const deleted = await repository.deleteGame("game-1");
  assert.equal(deleted, true);
  assert.equal(await repository.getGame("game-1"), null);
  assert.deepEqual(await repository.listSessionsForSeason("season-1"), []);
});

test("repository does not delete a game if it finishes before the delete transaction commits", async () => {
  const { repository, client } = createRepositoryHarness();

  await repository.createGame({
    gameId: "game-1",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    status: "live",
    gameStartTs: "2026-02-22T10:00:00Z",
  });

  client.runBeforeNextPut(() => markStoredGameFinished(client, "game-1"));

  assert.equal(await repository.deleteGame("game-1"), false);
  assert.equal((await repository.getGame("game-1"))?.status, "finished");
});

test("repository rejects roster assignment if the game finalizes before the write commits", async () => {
  const { repository, client } = createRepositoryHarness();

  await repository.createGame({
    gameId: "game-1",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    status: "live",
    gameStartTs: "2026-02-22T10:00:00Z",
  });
  await repository.createPlayer({
    playerId: "player-red",
    nickname: "Red Player",
  });

  client.runBeforeNextPut(() => markStoredGameFinished(client, "game-1"));

  await assert.rejects(
    repository.assignRosterPlayer({
      gameId: "game-1",
      teamId: "red",
      playerId: "player-red",
    }),
    (error) =>
      error instanceof GameMutationStateError &&
      error.code === "game_state_changed",
  );
  assert.deepEqual(await repository.listGameRoster("game-1"), []);
  assert.equal((await repository.getGame("game-1"))?.status, "finished");
});

test("repository rejects team overrides if the game finalizes before the write commits", async () => {
  const { repository, client } = createRepositoryHarness();

  await repository.createGame({
    gameId: "game-1",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    status: "live",
    gameStartTs: "2026-02-22T10:00:00Z",
  });

  client.runBeforeNextPut(() => markStoredGameFinished(client, "game-1"));

  await assert.rejects(
    repository.createGameTeamOverride({
      gameId: "game-1",
      teamId: "red",
      name: "Renamed Red",
      color: "#cc0000",
    }),
    (error) =>
      error instanceof GameMutationStateError &&
      error.code === "game_state_changed",
  );
  assert.deepEqual(await repository.listTeamsForGame("game-1"), []);
  assert.equal((await repository.getGame("game-1"))?.status, "finished");
});

test("repository create-only team overrides preserve existing score state", async () => {
  const { repository, client } = createRepositoryHarness();

  await repository.createGame({
    gameId: "game-1",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    status: "live",
    gameStartTs: "2026-02-22T10:00:00Z",
  });
  seedStoredGameTeam(client, {
    gameId: "game-1",
    teamId: "red",
    name: "Live Red",
    color: "#d83b36",
    scored: 3,
    conceded: 1,
    createdAt: "2026-02-22T10:01:00.000Z",
    updatedAt: "2026-02-22T10:02:00.000Z",
  });

  const preserved = await repository.createGameTeamOverride({
    gameId: "game-1",
    teamId: "red",
    name: "Default Red",
    color: "#ff0000",
    createOnly: true,
  });

  assert.deepEqual(preserved, {
    gameId: "game-1",
    teamId: "red",
    name: "Live Red",
    color: "#d83b36",
    scored: 3,
    conceded: 1,
    createdAt: "2026-02-22T10:01:00.000Z",
    updatedAt: "2026-02-22T10:02:00.000Z",
  });
  assert.deepEqual(await repository.listTeamsForGame("game-1"), [preserved]);
});

test("repository create-only season teams preserve existing configuration", async () => {
  const { repository, client } = createRepositoryHarness();
  seedStoredSeasonTeam(client, {
    seasonId: "season-1",
    teamId: "red",
    name: "Custom Red",
    color: "#aa0000",
    createdAt: "2026-02-22T10:01:00.000Z",
    updatedAt: "2026-02-22T10:02:00.000Z",
  });

  const preserved = await repository.createTeam({
    seasonId: "season-1",
    teamId: "red",
    name: "Default Red",
    color: "#ff0000",
    createOnly: true,
  });

  assert.deepEqual(preserved, {
    seasonId: "season-1",
    teamId: "red",
    name: "Custom Red",
    color: "#aa0000",
    createdAt: "2026-02-22T10:01:00.000Z",
    updatedAt: "2026-02-22T10:02:00.000Z",
  });
  assert.deepEqual(await repository.listTeamsForSeason("season-1"), [preserved]);
});

test("repository create-only season teams do not replace concurrent teams", async () => {
  const { repository, client } = createRepositoryHarness();
  client.runBeforeNextPut(() => {
    seedStoredSeasonTeam(client, {
      seasonId: "season-1",
      teamId: "red",
      name: "Concurrent Red",
      color: "#bb0000",
      createdAt: "2026-02-22T10:01:00.000Z",
      updatedAt: "2026-02-22T10:03:00.000Z",
    });
  });

  const concurrent = await repository.createTeam({
    seasonId: "season-1",
    teamId: "red",
    name: "Default Red",
    color: "#ff0000",
    createOnly: true,
  });

  assert.deepEqual(concurrent, {
    seasonId: "season-1",
    teamId: "red",
    name: "Concurrent Red",
    color: "#bb0000",
    createdAt: "2026-02-22T10:01:00.000Z",
    updatedAt: "2026-02-22T10:03:00.000Z",
  });
  assert.deepEqual(await repository.listTeamsForSeason("season-1"), [concurrent]);
});

test("repository create-only team overrides do not replace concurrent teams", async () => {
  const { repository, client } = createRepositoryHarness();

  await repository.createGame({
    gameId: "game-1",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    status: "live",
    gameStartTs: "2026-02-22T10:00:00Z",
  });
  client.runBeforeNextPut(() => {
    seedStoredGameTeam(client, {
      gameId: "game-1",
      teamId: "red",
      name: "Concurrent Red",
      color: "#d83b36",
      scored: 2,
      conceded: 4,
      createdAt: "2026-02-22T10:01:00.000Z",
      updatedAt: "2026-02-22T10:03:00.000Z",
    });
  });

  const concurrent = await repository.createGameTeamOverride({
    gameId: "game-1",
    teamId: "red",
    name: "Default Red",
    color: "#ff0000",
    createOnly: true,
  });

  assert.deepEqual(concurrent, {
    gameId: "game-1",
    teamId: "red",
    name: "Concurrent Red",
    color: "#d83b36",
    scored: 2,
    conceded: 4,
    createdAt: "2026-02-22T10:01:00.000Z",
    updatedAt: "2026-02-22T10:03:00.000Z",
  });
  assert.deepEqual(await repository.listTeamsForGame("game-1"), [concurrent]);
});

test("repository rejects game player links if the game finalizes before the write commits", async () => {
  const { repository, client } = createRepositoryHarness();

  await repository.createGame({
    gameId: "game-1",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    status: "live",
    gameStartTs: "2026-02-22T10:00:00Z",
  });
  await repository.createPlayer({
    playerId: "player-late",
    nickname: "Late",
  });

  client.runBeforeNextPut(() => markStoredGameFinished(client, "game-1"));

  await assert.rejects(
    repository.linkGamePlayer({
      gameId: "game-1",
      playerId: "player-late",
    }),
    (error) =>
      error instanceof GameMutationStateError &&
      error.code === "game_state_changed",
  );
  assert.deepEqual(await repository.listGamePlayers("game-1"), []);
  assert.equal((await repository.getGame("game-1"))?.status, "finished");
});

test("repository rejects quick player creation if the game finalizes before the write commits", async () => {
  const { repository, client } = createRepositoryHarness();

  await repository.createGame({
    gameId: "game-1",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    status: "live",
    gameStartTs: "2026-02-22T10:00:00Z",
  });

  client.runBeforeNextPut(() => markStoredGameFinished(client, "game-1"));

  await assert.rejects(
    repository.createAndLinkGamePlayer({
      gameId: "game-1",
      playerId: "player-late",
      nickname: "Late",
    }),
    (error) =>
      error instanceof GameMutationStateError &&
      error.code === "game_state_changed",
  );
  assert.equal(await repository.getPlayer("player-late"), null);
  assert.deepEqual(await repository.listGamePlayers("game-1"), []);
  assert.equal((await repository.getGame("game-1"))?.status, "finished");
});

test("repository gives legacy games default timer state without repairing join codes by default", async () => {
  const { repository, client } = createRepositoryHarness();

  client.seedItem({
    pk: { S: "GAME#game-legacy" },
    sk: { S: "METADATA" },
    entityType: { S: "game" },
    createdAt: { S: "2026-02-22T00:00:00.000Z" },
    updatedAt: { S: "2026-02-22T00:00:00.000Z" },
    data: {
      S: JSON.stringify({
        gameId: "game-legacy",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-1",
        status: "scheduled",
        gameStartTs: "2026-02-22T10:00:00.000Z",
      }),
    },
  });

  const game = await repository.getGame("game-legacy");
  assert.equal(game?.thirdLengthMinutes, DEFAULT_THIRD_LENGTH_MINUTES);
  assert.deepEqual(game?.thirds, createDefaultThirdTimerSegments());
  assert.equal(game?.joinCode, buildJoinCodeForGameId("game-legacy"));
  const lookupItem = client.readItem(`JOIN_CODE#${buildJoinCodeForGameId("game-legacy")}`, "METADATA");
  assert.equal(lookupItem ?? null, null);
});

test("repository repairs legacy game join codes with a random usable lookup when requested", async () => {
  const { repository, client } = createRepositoryHarness();

  client.seedItem({
    pk: { S: "GAME#game-legacy" },
    sk: { S: "METADATA" },
    entityType: { S: "game" },
    createdAt: { S: "2026-02-22T00:00:00.000Z" },
    updatedAt: { S: "2026-02-22T00:00:00.000Z" },
    data: {
      S: JSON.stringify({
        gameId: "game-legacy",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-1",
        status: "scheduled",
        gameStartTs: "2026-02-22T10:00:00.000Z",
      }),
    },
  });

  const game = await repository.getGame("game-legacy", { repairLegacyJoinCode: true });
  assert.ok(game);
  assert.match(game.joinCode, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  assert.notEqual(game.joinCode, buildJoinCodeForGameId("game-legacy"));
  assert.deepEqual(await repository.getGameByJoinCode(game.joinCode), game);
  const lookupItem = client.readItem(`JOIN_CODE#${game.joinCode}`, "METADATA");
  assert.equal(lookupItem?.entityType?.S, "gameJoinCode");
  assert.deepEqual(JSON.parse(lookupItem?.data?.S ?? "{}"), {
    joinCode: game.joinCode,
    gameId: "game-legacy",
  });
});

test("repository repairs legacy game join-code collisions with a usable fallback", async () => {
  const { repository, client } = createRepositoryHarness();
  const claimedJoinCode = buildJoinCodeForGameId("game-legacy");
  const currentGame = await repository.createGame({
    gameId: "game-current",
    joinCode: claimedJoinCode,
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-current",
    status: "scheduled",
    gameStartTs: "2026-02-22T10:00:00.000Z",
  });

  client.seedItem({
    pk: { S: "GAME#game-legacy" },
    sk: { S: "METADATA" },
    entityType: { S: "game" },
    createdAt: { S: "2026-02-22T00:00:00.000Z" },
    updatedAt: { S: "2026-02-22T00:00:00.000Z" },
    data: {
      S: JSON.stringify({
        gameId: "game-legacy",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-legacy",
        status: "scheduled",
        gameStartTs: "2026-02-22T11:00:00.000Z",
      }),
    },
  });

  const repairedGame = await repository.getGame("game-legacy", { repairLegacyJoinCode: true });
  assert.ok(repairedGame);
  assert.notEqual(repairedGame.joinCode, claimedJoinCode);
  assert.deepEqual(await repository.getGameByJoinCode(claimedJoinCode), currentGame);
  assert.deepEqual(await repository.getGameByJoinCode(repairedGame.joinCode), repairedGame);

  const storedGame = client.readItem("GAME#game-legacy", "METADATA");
  assert.equal(JSON.parse(storedGame?.data?.S ?? "{}").joinCode, repairedGame.joinCode);
  const repairedLookup = client.readItem(`JOIN_CODE#${repairedGame.joinCode}`, "METADATA");
  assert.deepEqual(JSON.parse(repairedLookup?.data?.S ?? "{}"), {
    joinCode: repairedGame.joinCode,
    gameId: "game-legacy",
  });
});

test("repository repairs missing legacy join codes before game metadata mutations", async () => {
  const { repository, client } = createRepositoryHarness();

  client.seedItem({
    pk: { S: "GAME#game-legacy" },
    sk: { S: "METADATA" },
    entityType: { S: "game" },
    createdAt: { S: "2026-02-22T00:00:00.000Z" },
    updatedAt: { S: "2026-02-22T00:00:00.000Z" },
    data: {
      S: JSON.stringify({
        gameId: "game-legacy",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-legacy",
        status: "scheduled",
        gameStartTs: "2026-02-22T10:00:00.000Z",
      }),
    },
  });

  const updatedGame = await repository.updateGame({
    gameId: "game-legacy",
    gameStartTs: "2026-02-22T10:15:00.000Z",
  });
  assert.ok(updatedGame);
  assert.match(updatedGame.joinCode, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  assert.notEqual(updatedGame.joinCode, buildJoinCodeForGameId("game-legacy"));

  const storedGame = client.readItem("GAME#game-legacy", "METADATA");
  assert.equal(JSON.parse(storedGame?.data?.S ?? "{}").joinCode, updatedGame.joinCode);
  const lookupItem = client.readItem(`JOIN_CODE#${updatedGame.joinCode}`, "METADATA");
  assert.deepEqual(JSON.parse(lookupItem?.data?.S ?? "{}"), {
    joinCode: updatedGame.joinCode,
    gameId: "game-legacy",
  });
  assert.deepEqual(await repository.getGameByJoinCode(updatedGame.joinCode), updatedGame);
});

test("repository repairs stored join codes that are missing lookup ownership", async () => {
  const { repository, client } = createRepositoryHarness();

  client.seedItem({
    pk: { S: "GAME#game-legacy" },
    sk: { S: "METADATA" },
    entityType: { S: "game" },
    createdAt: { S: "2026-02-22T00:00:00.000Z" },
    updatedAt: { S: "2026-02-22T00:00:00.000Z" },
    data: {
      S: JSON.stringify({
        gameId: "game-legacy",
        joinCode: "LEGACY23",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-legacy",
        status: "scheduled",
        gameStartTs: "2026-02-22T10:00:00.000Z",
      }),
    },
  });

  const repairedGame = await repository.getGame("game-legacy", { repairLegacyJoinCode: true });
  assert.ok(repairedGame);
  assert.equal(repairedGame.joinCode, "LEGACY23");
  const lookupItem = client.readItem("JOIN_CODE#LEGACY23", "METADATA");
  assert.deepEqual(JSON.parse(lookupItem?.data?.S ?? "{}"), {
    joinCode: "LEGACY23",
    gameId: "game-legacy",
  });
  assert.deepEqual(await repository.getGameByJoinCode("LEGACY23"), repairedGame);
});

test("repository does not delete another game's join-code lookup for legacy games", async () => {
  const { repository, client } = createRepositoryHarness();
  const claimedJoinCode = buildJoinCodeForGameId("game-legacy");
  const currentGame = await repository.createGame({
    gameId: "game-current",
    joinCode: claimedJoinCode,
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-current",
    status: "scheduled",
    gameStartTs: "2026-02-22T10:00:00.000Z",
  });

  client.seedItem({
    pk: { S: "GAME#game-legacy" },
    sk: { S: "METADATA" },
    entityType: { S: "game" },
    createdAt: { S: "2026-02-22T00:00:00.000Z" },
    updatedAt: { S: "2026-02-22T00:00:00.000Z" },
    data: {
      S: JSON.stringify({
        gameId: "game-legacy",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-legacy",
        status: "scheduled",
        gameStartTs: "2026-02-22T11:00:00.000Z",
      }),
    },
  });

  assert.equal(await repository.deleteGame("game-legacy"), true);
  assert.equal(await repository.getGame("game-legacy"), null);
  assert.deepEqual(await repository.getGameByJoinCode(claimedJoinCode), currentGame);
});

test("repository leaves game and join-code lookup intact if delete sees a join-code race", async () => {
  const { repository, client } = createRepositoryHarness();
  const game = await repository.createGame({
    gameId: "game-delete-race",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    status: "scheduled",
    gameStartTs: "2026-02-22T10:00:00.000Z",
  });

  client.runBeforeNextPut(() => {
    const item = client.readItem(`JOIN_CODE#${game.joinCode}`, "METADATA");
    if (!item?.data?.S) {
      throw new Error("Expected join code lookup item.");
    }

    const data = JSON.parse(item.data.S) as {
      gameId: string;
      joinCode: string;
    };
    item.data.S = JSON.stringify({
      ...data,
      gameId: "game-other",
    });
    item.updatedAt = { S: "2026-02-22T00:01:39.000Z" };
    client.seedItem(item);
  });

  assert.equal(await repository.deleteGame("game-delete-race"), false);
  assert.deepEqual(await repository.getGame("game-delete-race"), game);
  assert.equal(
    JSON.parse(client.readItem(`JOIN_CODE#${game.joinCode}`, "METADATA")?.data?.S ?? "{}").gameId,
    "game-other",
  );
});

test("repository rejects join registration for finished games without creating a player", async () => {
  const { repository, client } = createRepositoryHarness();
  const game = await repository.createGame({
    gameId: "game-finished-join",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    gameStartTs: "2026-02-22T10:00:00Z",
  });
  markStoredGameFinished(client, "game-finished-join");

  await assert.rejects(
    repository.joinGameByCode({
      joinCode: game.joinCode,
      playerId: "player-late",
      nickname: "Late",
    }),
    (error) =>
      error instanceof GameJoinRegistrationError &&
      error.code === "game_finished" &&
      error.statusCode === 409,
  );
  assert.equal(await repository.getPlayer("player-late"), null);
  assert.deepEqual(await repository.listGamePlayers(game.gameId), []);
});

test("repository rejects join registration if join code lookup changes before write", async () => {
  const { repository, client } = createRepositoryHarness();
  const game = await repository.createGame({
    gameId: "game-join-code-race",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    gameStartTs: "2026-02-22T10:00:00Z",
  });

  client.runBeforeNextPut(() => {
    const item = client.readItem(`JOIN_CODE#${game.joinCode}`, "METADATA");
    if (!item?.data?.S) {
      throw new Error("Expected join code lookup item.");
    }

    const data = JSON.parse(item.data.S) as {
      gameId: string;
    };
    data.gameId = "game-rotated-join-code";
    item.data.S = JSON.stringify(data);
    item.updatedAt = { S: "2026-02-22T00:01:39.000Z" };
    client.seedItem(item);
  });

  await assert.rejects(
    repository.joinGameByCode({
      joinCode: game.joinCode,
      playerId: "player-racy-join",
      nickname: "Racy Join",
    }),
    (error) =>
      error instanceof GameJoinRegistrationError &&
      error.code === "join_state_changed" &&
      error.statusCode === 409,
  );
  assert.equal(await repository.getPlayer("player-racy-join"), null);
  assert.deepEqual(await repository.listGamePlayers(game.gameId), []);
});

test("repository replays existing public join registration after idempotency recording failures", async () => {
  const repository = createRepository();
  const game = await repository.createGame({
    gameId: "game-join-replay",
    joinCode: "REPLAY23",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    status: "live",
    gameStartTs: "2026-02-22T10:00:00.000Z",
  });

  const firstJoin = await repository.joinGameByCode({
    joinCode: game.joinCode,
    playerId: "player-join-replay",
    nickname: "Nia",
  });
  assert.ok(firstJoin);

  const replayedJoin = await repository.joinGameByCode({
    joinCode: game.joinCode,
    playerId: "player-join-replay",
    nickname: "Nia",
  });
  assert.deepEqual(replayedJoin, firstJoin);

  await assert.rejects(
    repository.joinGameByCode({
      joinCode: game.joinCode,
      playerId: "player-join-replay",
      nickname: "Mia",
    }),
    (error) =>
      error instanceof GameJoinRegistrationError &&
      error.code === "join_state_changed",
  );
});

test("repository rethrows non-conditional transaction cancellation when joining by code", async () => {
  const { repository, client } = createRepositoryHarness();
  const game = await repository.createGame({
    gameId: "game-join-cancelled",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    gameStartTs: "2026-02-22T10:00:00Z",
  });

  client.runBeforeNextPut(() => {
    const error = new Error("Join transaction validation failed.");
    (
      error as Error & {
        name: string;
        CancellationReasons: Array<{ Code: string }>;
      }
    ).name = "TransactionCanceledException";
    (
      error as Error & {
        name: string;
        CancellationReasons: Array<{ Code: string }>;
      }
    ).CancellationReasons = [{ Code: "ValidationError" }];
    throw error;
  });

  await assert.rejects(
    repository.joinGameByCode({
      joinCode: game.joinCode,
      playerId: "player-join-cancelled",
      nickname: "Join Cancelled",
    }),
    /Join transaction validation failed/,
  );
  assert.equal(await repository.getPlayer("player-join-cancelled"), null);
  assert.deepEqual(await repository.listGamePlayers(game.gameId), []);
});

test("repository enforces third timer transitions in order", async () => {
  const repository = createRepository();

  await repository.createGame({
    gameId: "game-1",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    gameStartTs: "2026-02-22T10:00:00Z",
    thirdLengthMinutes: 25,
  });

  await assert.rejects(
    repository.finishGameThird({ gameId: "game-1", third: 1 }),
    /cannot be finished before it is started/,
  );

  const startedFirst = await repository.startGameThird({ gameId: "game-1", third: 1 });
  assert.equal(startedFirst?.status, "live");
  assert.equal(startedFirst?.thirdLengthMinutes, 25);
  assert.equal(startedFirst?.thirds[0].startedAt, "2026-02-22T00:00:01.000Z");
  assert.equal(startedFirst?.thirds[0].finishedAt, null);

  await assert.rejects(
    repository.startGameThird({ gameId: "game-1", third: 1 }),
    /already been started/,
  );
  await assert.rejects(
    repository.startGameThird({ gameId: "game-1", third: 2 }),
    /Third 1 must be finished before another third can start/,
  );

  const finishedFirst = await repository.finishGameThird({ gameId: "game-1", third: 1 });
  assert.equal(finishedFirst?.thirds[0].finishedAt, "2026-02-22T00:00:02.000Z");

  const startedSecond = await repository.startGameThird({ gameId: "game-1", third: 2 });
  assert.equal(startedSecond?.thirds[1].startedAt, "2026-02-22T00:00:03.000Z");
});

test("repository rejects stale timer transition writes without overwriting newer state", async () => {
  const { repository, client } = createRepositoryHarness();

  await repository.createGame({
    gameId: "game-1",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    gameStartTs: "2026-02-22T10:00:00Z",
  });

  client.runBeforeNextPut(() => {
    const item = client.readItem("GAME#game-1", "METADATA");
    if (!item?.data?.S) {
      throw new Error("Expected seeded game item.");
    }
    const data = JSON.parse(item.data.S) as {
      status: "scheduled" | "live" | "finished";
      thirds: Array<{ third: number; startedAt: string | null; finishedAt: string | null }>;
    };
    data.status = "live";
    data.thirds[0].startedAt = "2026-02-22T00:01:29.000Z";
    item.data.S = JSON.stringify(data);
    item.updatedAt = { S: "2026-02-22T00:01:39.000Z" };
    client.seedItem(item);
  });

  await assert.rejects(
    repository.startGameThird({ gameId: "game-1", third: 1 }),
    /Timer state changed while applying this transition/,
  );
  const externallyStarted = await repository.getGame("game-1");
  assert.equal(externallyStarted?.thirds[0].startedAt, "2026-02-22T00:01:29.000Z");

  client.runBeforeNextPut(() => {
    const item = client.readItem("GAME#game-1", "METADATA");
    if (!item?.data?.S) {
      throw new Error("Expected seeded game item.");
    }
    const data = JSON.parse(item.data.S) as {
      thirds: Array<{ third: number; startedAt: string | null; finishedAt: string | null }>;
    };
    data.thirds[0].finishedAt = "2026-02-22T00:02:39.000Z";
    item.data.S = JSON.stringify(data);
    item.updatedAt = { S: "2026-02-22T00:02:39.000Z" };
    client.seedItem(item);
  });

  await assert.rejects(
    repository.finishGameThird({ gameId: "game-1", third: 1 }),
    /Timer state changed while applying this transition/,
  );
  const externallyFinished = await repository.getGame("game-1");
  assert.equal(externallyFinished?.thirds[0].finishedAt, "2026-02-22T00:02:39.000Z");
});

test("timer display formatting switches to stoppage after nominal length", () => {
  assert.deepEqual(formatThirdDisplayTime(1199, 20), {
    displayTime: "19:59",
    phase: "regulation",
    elapsedSeconds: 1199,
    stoppageSeconds: 0,
    stoppageMinute: null,
  });
  assert.deepEqual(formatThirdDisplayTime(1200, 20), {
    displayTime: "20:00",
    phase: "regulation",
    elapsedSeconds: 1200,
    stoppageSeconds: 0,
    stoppageMinute: null,
  });
  assert.deepEqual(formatThirdDisplayTime(1201, 20), {
    displayTime: "20+01",
    phase: "stoppage",
    elapsedSeconds: 1201,
    stoppageSeconds: 1,
    stoppageMinute: 1,
  });
  assert.deepEqual(formatThirdDisplayTime(1260, 20), {
    displayTime: "20+02",
    phase: "stoppage",
    elapsedSeconds: 1260,
    stoppageSeconds: 60,
    stoppageMinute: 2,
  });
});

test("repository locks third length after timer starts and rejects finished games", async () => {
  const { repository, client } = createRepositoryHarness();

  await repository.createGame({
    gameId: "game-1",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    gameStartTs: "2026-02-22T10:00:00Z",
  });

  const rescheduled = await repository.updateGame({
    gameId: "game-1",
    thirdLengthMinutes: 30,
  });
  assert.equal(rescheduled?.thirdLengthMinutes, 30);

  await repository.startGameThird({ gameId: "game-1", third: 1 });
  await assert.rejects(
    repository.updateGame({
      gameId: "game-1",
      status: "scheduled",
    }),
    /Game status cannot be set back to scheduled after a third has started/,
  );
  await assert.rejects(
    repository.updateGame({
      gameId: "game-1",
      thirdLengthMinutes: 20,
    }),
    /Third length cannot be changed after a third has started/,
  );

  await assert.rejects(
    repository.updateGame({
      gameId: "game-1",
      status: "finished",
    }),
    /Use POST \/v1\/games\/\{gameId\}\/finish/,
  );

  await repository.createGame({
    gameId: "game-finished",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    gameStartTs: "2026-02-22T11:00:00Z",
  });
  markStoredGameFinished(client, "game-finished");
  await assert.rejects(
    repository.finishGameThird({ gameId: "game-finished", third: 1 }),
    /Cannot finish a third after the game is finished/,
  );
});

test("repository rejects third length changes on finished games even before timer starts", async () => {
  const { repository, client } = createRepositoryHarness();

  await repository.createGame({
    gameId: "game-1",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    gameStartTs: "2026-02-22T10:00:00Z",
  });
  markStoredGameFinished(client, "game-1");

  await assert.rejects(
    repository.updateGame({
      gameId: "game-1",
      thirdLengthMinutes: 30,
    }),
    /Third length cannot be changed after the game is finished/,
  );
});

test("repository blocks deleting season or league while descendants exist", async () => {
  const repository = createRepository();

  await repository.createLeague({
    leagueId: "league-1",
    name: "Three FC",
    createdByUserId: "admin@example.com",
  });
  await repository.createSeason({
    leagueId: "league-1",
    seasonId: "season-1",
    name: "Season One",
  });
  await repository.createSession({
    seasonId: "season-1",
    sessionId: "20260222",
    sessionDate: "2026-02-22",
  });

  await assert.rejects(
    repository.deleteSeason("season-1"),
    /Cannot delete season with existing games/,
  );

  await assert.rejects(
    repository.deleteLeague("league-1"),
    /Cannot delete league with existing seasons/,
  );
});

test("repository supports idempotency record create/get semantics", async () => {
  const { repository, client } = createRepositoryHarness();

  const created = await repository.createIdempotencyRecord({
    scope: "admin@example.com:POST:/v1/leagues",
    key: "create-league-1",
    requestHash: "hash-1",
    responseStatusCode: 201,
    responseBody: JSON.stringify({ leagueId: "league-1" }),
  });

  const duplicate = await repository.createIdempotencyRecord({
    scope: "admin@example.com:POST:/v1/leagues",
    key: "create-league-1",
    requestHash: "hash-1",
    responseStatusCode: 201,
    responseBody: JSON.stringify({ leagueId: "league-1" }),
  });

  client.getItemRequests.length = 0;
  const record = await repository.getIdempotencyRecord(
    "admin@example.com:POST:/v1/leagues",
    "create-league-1",
  );

  assert.equal(created, true);
  assert.equal(duplicate, false);
  assert.equal(record?.requestHash, "hash-1");
  assert.equal(record?.responseStatusCode, 201);
  assert.equal(record?.responseBody, JSON.stringify({ leagueId: "league-1" }));
  assert.deepEqual(
    client.getItemRequests.map((request) => request.consistentRead),
    [true],
  );
});

async function setupScoringGame(repository: ThreeFcRepository): Promise<void> {
  await repository.createGame({
    gameId: "game-1",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    gameStartTs: "2026-02-22T10:00:00Z",
  });
  for (const team of [
    { teamId: "red" as const, name: "Red" },
    { teamId: "blue" as const, name: "Blue" },
    { teamId: "yellow" as const, name: "Yellow" },
  ]) {
    await repository.createGameTeamOverride({
      gameId: "game-1",
      teamId: team.teamId,
      name: team.name,
      color: null,
    });
  }
  for (const player of [
    { playerId: "player-red", nickname: "Red Player", teamId: "red" as const },
    { playerId: "player-blue", nickname: "Blue Player", teamId: "blue" as const },
    { playerId: "player-yellow", nickname: "Yellow Player", teamId: "yellow" as const },
  ]) {
    await repository.createPlayer({
      playerId: player.playerId,
      nickname: player.nickname,
    });
    await repository.assignRosterPlayer({
      gameId: "game-1",
      teamId: player.teamId,
      playerId: player.playerId,
    });
  }
}

async function completeAllThirds(repository: ThreeFcRepository, input: { firstThirdStarted?: boolean } = {}): Promise<void> {
  for (const third of [1, 2, 3] as const) {
    if (!(input.firstThirdStarted && third === 1)) {
      await repository.startGameThird({ gameId: "game-1", third });
    }
    await repository.finishGameThird({ gameId: "game-1", third });
  }
}

test("repository finishes a game with deterministic clear-winner result", async () => {
  const repository = createRepository();
  await setupScoringGame(repository);
  await repository.startGameThird({ gameId: "game-1", third: 1 });

  await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-finish-1",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-red",
    assistPlayerIds: [],
    ownGoal: false,
  });
  await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-finish-2",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: "yellow",
    concedingTeamId: "blue",
    scorerPlayerId: "player-yellow",
    assistPlayerIds: [],
    ownGoal: false,
  });
  await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-finish-3",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: "yellow",
    concedingTeamId: "red",
    scorerPlayerId: "player-yellow",
    assistPlayerIds: [],
    ownGoal: false,
  });
  await completeAllThirds(repository, { firstThirdStarted: true });

  const finished = await repository.finishGame({ gameId: "game-1" });

  assert.ok(finished);
  assert.equal(finished.status, "finished");
  assert.match(finished.finishedAt ?? "", /^2026-02-22T00:00:\d{2}\.000Z$/);
  assert.equal(finished.result?.winnerTeamId, "yellow");
  assert.equal(finished.result?.outcome, "win");
  assert.equal(finished.result?.comparator, "fewest_conceded_then_most_scored");
  assert.deepEqual(
    finished.result?.teams.map((team) => ({
      teamId: team.teamId,
      scored: team.scored,
      conceded: team.conceded,
      rank: team.rank,
      outcome: team.outcome,
    })),
    [
      { teamId: "yellow", scored: 2, conceded: 0, rank: 1, outcome: "win" },
      { teamId: "red", scored: 1, conceded: 1, rank: 2, outcome: "loss" },
      { teamId: "blue", scored: 0, conceded: 2, rank: 3, outcome: "loss" },
    ],
  );
  assert.deepEqual(await repository.finishGame({ gameId: "game-1" }), finished);
});

test("repository finishes a game with full draw result", async () => {
  const repository = createRepository();
  await setupScoringGame(repository);
  await completeAllThirds(repository);

  const finished = await repository.finishGame({ gameId: "game-1" });

  assert.ok(finished);
  assert.equal(finished.status, "finished");
  assert.equal(finished.result?.winnerTeamId, null);
  assert.equal(finished.result?.outcome, "draw");
  assert.deepEqual(
    finished.result?.teams.map((team) => ({
      teamId: team.teamId,
      scored: team.scored,
      conceded: team.conceded,
      rank: team.rank,
      outcome: team.outcome,
    })),
    [
      { teamId: "red", scored: 0, conceded: 0, rank: 1, outcome: "draw" },
      { teamId: "blue", scored: 0, conceded: 0, rank: 1, outcome: "draw" },
      { teamId: "yellow", scored: 0, conceded: 0, rank: 1, outcome: "draw" },
    ],
  );
});

test("repository normalizes persisted game results to contract-safe values", async () => {
  const { repository, client } = createRepositoryHarness();
  await repository.createGame({
    gameId: "game-result-normalize",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    gameStartTs: "2026-02-22T10:00:00.000Z",
  });

  const item = client.readItem("GAME#game-result-normalize", "METADATA");
  if (!item?.data?.S) {
    throw new Error("Expected seeded game item.");
  }

  const data = JSON.parse(item.data.S) as {
    status: "scheduled" | "live" | "finished";
    finishedAt: string | null;
    result: unknown;
  };
  data.status = "finished";
  data.finishedAt = "not-a-date";
  data.result = {
    winnerTeamId: "red",
    outcome: "draw",
    comparator: "fewest_conceded_then_most_scored",
    computedAt: "2026-02-22T00:01:39.000Z",
    teams: [
      {
        teamId: "red",
        name: "Red",
        color: "#d83b36",
        scored: 1,
        conceded: 0,
        rank: 0,
        outcome: "draw",
      },
      {
        teamId: "blue",
        name: "Blue",
        color: "#2364d2",
        scored: 0,
        conceded: 1,
        rank: 2,
        outcome: "loss",
      },
      {
        teamId: "yellow",
        name: "Yellow",
        color: "#e0a612",
        scored: 0,
        conceded: 0,
        rank: 2,
        outcome: "loss",
      },
    ],
  };
  const validResultPayload = data.result as Record<string, unknown>;
  item.data.S = JSON.stringify(data);
  item.updatedAt = { S: "2026-02-22T00:01:39.000Z" };
  client.seedItem(item);

  const normalized = await repository.getGame("game-result-normalize");
  assert.equal(normalized?.finishedAt, null);
  assert.equal(normalized?.result?.outcome, "win");
  assert.equal(normalized?.result?.teams[0]?.rank, 1);

  data.result = {
    ...validResultPayload,
    teams: [
      {
        teamId: "red",
        name: "Red",
        color: "#d83b36",
        scored: 0,
        conceded: 0,
        rank: 1,
        outcome: "draw",
      },
    ],
  };
  item.data.S = JSON.stringify(data);
  client.seedItem(item);

  const incompleteResult = await repository.getGame("game-result-normalize");
  assert.equal(incompleteResult?.result, null);

  data.result = {
    ...validResultPayload,
    computedAt: "not-a-date",
  };
  item.data.S = JSON.stringify(data);
  client.seedItem(item);

  const invalidResult = await repository.getGame("game-result-normalize");
  assert.equal(invalidResult?.result, null);
});

test("repository rejects finish until all thirds are completed", async () => {
  const repository = createRepository();
  await setupScoringGame(repository);

  await assert.rejects(
    repository.finishGame({ gameId: "game-1" }),
    /All three thirds must be started and finished/,
  );

  await repository.startGameThird({ gameId: "game-1", third: 1 });
  await repository.finishGameThird({ gameId: "game-1", third: 1 });

  await assert.rejects(
    repository.finishGame({ gameId: "game-1" }),
    /All three thirds must be started and finished/,
  );
});

test("repository backfills legacy finished games without completed thirds", async () => {
  const { repository, client } = createRepositoryHarness();
  await setupScoringGame(repository);
  const item = client.readItem("GAME#game-1", "METADATA");
  assert.ok(item);
  const rawData = item.data?.S;
  if (typeof rawData !== "string") {
    throw new Error("Stored game metadata is missing JSON data.");
  }
  const data = JSON.parse(rawData) as Record<string, unknown>;
  item.data = {
    S: JSON.stringify({
      ...data,
      status: "finished",
      finishedAt: null,
      result: null,
    }),
  };
  item.updatedAt = { S: "2026-02-23T00:00:59.000Z" };
  client.seedItem(item);

  const repaired = await repository.finishGame({ gameId: "game-1" });

  assert.equal(repaired?.status, "finished");
  assert.ok(repaired?.finishedAt);
  assert.equal(repaired?.result?.outcome, "draw");
  assert.equal(repaired?.result?.teams.length, 3);
  const stored = await repository.getGame("game-1");
  assert.equal(stored?.finishedAt, repaired?.finishedAt);
  assert.deepEqual(stored?.result, repaired?.result);
});

test("repository rejects manual finished status changes through updateGame", async () => {
  const repository = createRepository();
  await setupScoringGame(repository);

  await assert.rejects(
    repository.updateGame({ gameId: "game-1", status: "finished" }),
    /Use POST \/v1\/games\/\{gameId\}\/finish/,
  );

  await completeAllThirds(repository);
  const finished = await repository.finishGame({ gameId: "game-1" });
  assert.equal(finished?.status, "finished");

  await assert.rejects(
    repository.updateGame({ gameId: "game-1", status: "live" }),
    /Finished games cannot be moved back to scheduled or live/,
  );
});

test("repository recomputes finished game result after team corrections", async () => {
  const repository = createRepository();
  await setupScoringGame(repository);
  await repository.startGameThird({ gameId: "game-1", third: 1 });
  await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-team-result-correction",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-red",
    assistPlayerIds: [],
    ownGoal: false,
  });
  await completeAllThirds(repository, { firstThirdStarted: true });
  const finishedBeforeCorrection = await repository.finishGame({ gameId: "game-1" });
  assert.equal(finishedBeforeCorrection?.result?.teams[0]?.name, "Red");

  const updatedTeam = await repository.createGameTeamOverride({
    gameId: "game-1",
    teamId: "red",
    name: "Ruby",
    color: "#aa0000",
    allowFinished: true,
  });

  assert.equal(updatedTeam.name, "Ruby");
  const finishedAfterCorrection = await repository.getGame("game-1");
  assert.equal(finishedAfterCorrection?.status, "finished");
  assert.equal(finishedAfterCorrection?.result?.winnerTeamId, "red");
  assert.equal(finishedAfterCorrection?.result?.teams[0]?.teamId, "red");
  assert.equal(finishedAfterCorrection?.result?.teams[0]?.name, "Ruby");
  assert.equal(finishedAfterCorrection?.result?.teams[0]?.color, "#aa0000");
});

test("repository create-only team overrides repair missing finished-game teams", async () => {
  const { repository, client } = createRepositoryHarness();
  await setupScoringGame(repository);
  await completeAllThirds(repository);
  const finishedBeforeRepair = await repository.finishGame({ gameId: "game-1" });
  assert.equal(finishedBeforeRepair?.status, "finished");

  await client.send(
    new DeleteItemCommand({
      TableName: "threefc_test",
      Key: {
        pk: { S: "GAME#game-1" },
        sk: { S: "TEAM#yellow" },
      },
    }),
  );

  const repairedTeam = await repository.createGameTeamOverride({
    gameId: "game-1",
    teamId: "yellow",
    name: "Yellow",
    color: "#e0a612",
    allowFinished: true,
    createOnly: true,
  });

  assert.deepEqual(
    {
      teamId: repairedTeam.teamId,
      name: repairedTeam.name,
      color: repairedTeam.color,
      scored: repairedTeam.scored,
      conceded: repairedTeam.conceded,
    },
    {
      teamId: "yellow",
      name: "Yellow",
      color: "#e0a612",
      scored: 0,
      conceded: 0,
    },
  );
  const finishedAfterRepair = await repository.getGame("game-1");
  assert.equal(finishedAfterRepair?.status, "finished");
  assert.equal(
    finishedAfterRepair?.result?.teams.some((team) => team.teamId === "yellow"),
    true,
  );
  assert.deepEqual(
    (await repository.listTeamsForGame("game-1")).map((team) => team.teamId),
    ["red", "blue", "yellow"],
  );
});

test("repository create-only team repair waits for all teams before completing finished results", async () => {
  const { repository, client } = createRepositoryHarness();

  client.seedItem({
    pk: { S: "GAME#game-legacy-finished" },
    sk: { S: "METADATA" },
    entityType: { S: "game" },
    createdAt: { S: "2026-02-22T00:00:00.000Z" },
    updatedAt: { S: "2026-02-22T00:00:00.000Z" },
    data: {
      S: JSON.stringify({
        gameId: "game-legacy-finished",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-1",
        status: "finished",
        gameStartTs: "2026-02-22T10:00:00.000Z",
        finishedAt: null,
        result: null,
      }),
    },
  });
  client.seedItem({
    pk: { S: "GAME#game-legacy-finished" },
    sk: { S: "TEAM#red" },
    entityType: { S: "gameTeam" },
    createdAt: { S: "2026-02-22T00:00:00.000Z" },
    updatedAt: { S: "2026-02-22T00:00:00.000Z" },
    data: {
      S: JSON.stringify({
        gameId: "game-legacy-finished",
        teamId: "red",
        name: "Red",
        color: "#d83b36",
        scored: 0,
        conceded: 0,
      }),
    },
  });

  await repository.createGameTeamOverride({
    gameId: "game-legacy-finished",
    teamId: "yellow",
    name: "Yellow",
    color: "#e0a612",
    allowFinished: true,
    createOnly: true,
  });

  const stillIncomplete = await repository.getGame("game-legacy-finished");
  assert.equal(stillIncomplete?.status, "finished");
  assert.equal(stillIncomplete?.finishedAt, null);
  assert.equal(stillIncomplete?.result, null);

  await repository.createGameTeamOverride({
    gameId: "game-legacy-finished",
    teamId: "blue",
    name: "Blue",
    color: "#2f6fed",
    allowFinished: true,
    createOnly: true,
  });

  const complete = await repository.getGame("game-legacy-finished");
  assert.equal(complete?.status, "finished");
  assert.ok(complete?.finishedAt);
  assert.deepEqual(
    complete.result?.teams.map((team) => team.teamId).sort(),
    ["blue", "red", "yellow"],
  );
});

test("repository recomputes partial finished results once all teams exist", async () => {
  const { repository, client } = createRepositoryHarness();

  client.seedItem({
    pk: { S: "GAME#game-legacy-partial-result" },
    sk: { S: "METADATA" },
    entityType: { S: "game" },
    createdAt: { S: "2026-02-22T00:00:00.000Z" },
    updatedAt: { S: "2026-02-22T00:00:00.000Z" },
    data: {
      S: JSON.stringify({
        gameId: "game-legacy-partial-result",
        leagueId: "league-1",
        seasonId: "season-1",
        sessionId: "session-1",
        status: "finished",
        gameStartTs: "2026-02-22T10:00:00.000Z",
        finishedAt: "2026-02-22T11:00:00.000Z",
        result: {
          winnerTeamId: null,
          outcome: "draw",
          comparator: "fewest_conceded_then_most_scored",
          computedAt: "2026-02-22T11:00:00.000Z",
          teams: [
            {
              teamId: "red",
              name: "Red",
              color: "#d83b36",
              scored: 0,
              conceded: 0,
              rank: 1,
              outcome: "draw",
            },
          ],
        },
      }),
    },
  });

  for (const team of [
    { teamId: "red", name: "Red", color: "#d83b36" },
    { teamId: "yellow", name: "Yellow", color: "#e0a612" },
    { teamId: "blue", name: "Blue", color: "#2f6fed" },
  ] as const) {
    client.seedItem({
      pk: { S: "GAME#game-legacy-partial-result" },
      sk: { S: `TEAM#${team.teamId}` },
      entityType: { S: "gameTeam" },
      createdAt: { S: "2026-02-22T00:00:00.000Z" },
      updatedAt: { S: "2026-02-22T00:00:00.000Z" },
      data: {
        S: JSON.stringify({
          gameId: "game-legacy-partial-result",
          teamId: team.teamId,
          name: team.name,
          color: team.color,
          scored: 0,
          conceded: 0,
        }),
      },
    });
  }

  const repaired = await repository.finishGame({ gameId: "game-legacy-partial-result" });

  assert.deepEqual(
    repaired?.result?.teams.map((team) => team.teamId).sort(),
    ["blue", "red", "yellow"],
  );
});

test("repository recomputes finished game result after goal corrections", async () => {
  const repository = createRepository();
  await setupScoringGame(repository);
  await repository.startGameThird({ gameId: "game-1", third: 1 });

  await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-finished-correction",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-red",
    assistPlayerIds: [],
    ownGoal: false,
  });
  await completeAllThirds(repository, { firstThirdStarted: true });
  const finishedBeforeCorrection = await repository.finishGame({ gameId: "game-1" });
  assert.equal(finishedBeforeCorrection?.result?.winnerTeamId, "red");

  await repository.updateGoal({
    gameId: "game-1",
    eventId: "goal-finished-correction",
    actorUserId: "admin@example.com",
    allowFinished: true,
    scoringTeamId: "blue",
    concedingTeamId: "red",
    scorerPlayerId: "player-blue",
    assistPlayerIds: [],
    ownGoal: false,
  });

  const finishedAfterCorrection = await repository.getGame("game-1");
  assert.equal(finishedAfterCorrection?.status, "finished");
  assert.equal(finishedAfterCorrection?.result?.winnerTeamId, "blue");
  assert.deepEqual(
    finishedAfterCorrection?.result?.teams.map((team) => ({
      teamId: team.teamId,
      scored: team.scored,
      conceded: team.conceded,
      rank: team.rank,
      outcome: team.outcome,
    })),
    [
      { teamId: "blue", scored: 1, conceded: 0, rank: 1, outcome: "win" },
      { teamId: "yellow", scored: 0, conceded: 0, rank: 2, outcome: "loss" },
      { teamId: "red", scored: 0, conceded: 1, rank: 3, outcome: "loss" },
    ],
  );
});

test("repository creates finished-game goal corrections and recomputes result", async () => {
  const repository = createRepository();
  await setupScoringGame(repository);
  await completeAllThirds(repository);
  const finishedBeforeCorrection = await repository.finishGame({ gameId: "game-1" });
  assert.equal(finishedBeforeCorrection?.status, "finished");
  assert.equal(finishedBeforeCorrection?.result?.winnerTeamId, null);

  const result = await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-created-after-finish",
    actorUserId: "admin@example.com",
    allowFinished: true,
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-red",
    assistPlayerIds: [],
    ownGoal: false,
  });

  assert.ok(result);
  assert.equal(result.goal.third, 3);
  assert.equal(result.goal.thirdMinute, 20);
  assert.equal(result.goal.gameMinute, 60);
  assert.equal(result.goal.displayTime, "20:00");
  assert.deepEqual(
    result.scoreboard.teams.map((team) => ({
      teamId: team.teamId,
      scored: team.scored,
      conceded: team.conceded,
    })),
    [
      { teamId: "red", scored: 1, conceded: 0 },
      { teamId: "blue", scored: 0, conceded: 1 },
      { teamId: "yellow", scored: 0, conceded: 0 },
    ],
  );

  const finishedAfterCorrection = await repository.getGame("game-1");
  assert.equal(finishedAfterCorrection?.status, "finished");
  assert.equal(finishedAfterCorrection?.result?.winnerTeamId, "red");
});

test("repository creates finished-game goal corrections for legacy games without completed thirds", async () => {
  const { repository, client } = createRepositoryHarness();
  await setupScoringGame(repository);
  markStoredGameFinished(client, "game-1");

  const legacyFinished = await repository.getGame("game-1");
  assert.equal(legacyFinished?.status, "finished");
  assert.deepEqual(
    legacyFinished?.thirds.map((third) => third.finishedAt),
    [null, null, null],
  );

  const result = await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-created-after-legacy-finish",
    actorUserId: "admin@example.com",
    allowFinished: true,
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-red",
    assistPlayerIds: [],
    ownGoal: false,
  });

  assert.ok(result);
  assert.equal(result.goal.third, 3);
  assert.equal(result.goal.thirdMinute, DEFAULT_THIRD_LENGTH_MINUTES);
  assert.equal(result.goal.gameMinute, DEFAULT_THIRD_LENGTH_MINUTES * 3);
  assert.equal(result.goal.displayTime, `${DEFAULT_THIRD_LENGTH_MINUTES}:00`);
  assert.equal(result.goal.elapsedSeconds, DEFAULT_THIRD_LENGTH_MINUTES * 60);

  const finishedAfterCorrection = await repository.getGame("game-1");
  assert.equal(finishedAfterCorrection?.status, "finished");
  assert.equal(finishedAfterCorrection?.result?.winnerTeamId, "red");
});

test("repository requires finished-game authority for goal corrections", async () => {
  const repository = createRepository();
  await setupScoringGame(repository);
  await repository.startGameThird({ gameId: "game-1", third: 1 });

  await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-finished-authority",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-red",
    assistPlayerIds: [],
    ownGoal: false,
  });
  await completeAllThirds(repository, { firstThirdStarted: true });
  const finished = await repository.finishGame({ gameId: "game-1" });
  assert.equal(finished?.status, "finished");

  await assert.rejects(
    repository.updateGoal({
      gameId: "game-1",
      eventId: "goal-finished-authority",
      actorUserId: "scorekeeper@example.com",
      scoringTeamId: "blue",
      concedingTeamId: "red",
      scorerPlayerId: "player-blue",
      assistPlayerIds: [],
      ownGoal: false,
    }),
    /Admin role is required to mutate finished games/,
  );

  await assert.rejects(
    repository.deleteGoal({
      gameId: "game-1",
      eventId: "goal-finished-authority",
      actorUserId: "scorekeeper@example.com",
    }),
    /Admin role is required to mutate finished games/,
  );

  const [goal] = await repository.listGoalEvents("game-1");
  assert.equal(goal?.scoringTeamId, "red");
});

test("repository creates standard goals with timer stamping, mixed-team assists, and persisted tallies", async () => {
  const { repository, client } = createRepositoryHarness();
  await setupScoringGame(repository);
  await repository.startGameThird({ gameId: "game-1", third: 1 });

  const result = await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-1",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-red",
    assistPlayerIds: ["player-blue", "player-yellow"],
    ownGoal: false,
  });

  assert.ok(result);
  assert.equal(result.goal.third, 1);
  assert.equal(result.goal.thirdMinute, 1);
  assert.equal(result.goal.gameMinute, 1);
  assert.equal(result.goal.displayTime, "00:01");
  assert.equal(result.goal.stoppageMinute, null);
  assert.deepEqual(result.goal.assistPlayerIds, ["player-blue", "player-yellow"]);
  assert.deepEqual(
    result.scoreboard.teams.map((team) => ({
      teamId: team.teamId,
      scored: team.scored,
      conceded: team.conceded,
    })),
    [
      { teamId: "red", scored: 1, conceded: 0 },
      { teamId: "blue", scored: 0, conceded: 1 },
      { teamId: "yellow", scored: 0, conceded: 0 },
    ],
  );
  assert.deepEqual(
    (await repository.listTeamsForGame("game-1")).map((team) => ({
      teamId: team.teamId,
      scored: team.scored,
      conceded: team.conceded,
    })),
    [
      { teamId: "red", scored: 1, conceded: 0 },
      { teamId: "blue", scored: 0, conceded: 1 },
      { teamId: "yellow", scored: 0, conceded: 0 },
    ],
  );
  assert.deepEqual(result.timeline.map((goal) => goal.eventId), ["goal-1"]);
  assert.deepEqual(
    client
      .readQueries()
      .filter((query) => query.pk === "GAME#game-1" && query.skPrefix === "GOAL#")
      .map((query) => query.consistentRead),
    [true],
  );
});

test("repository stamps regulation-boundary goals at the final regulation minute", async () => {
  const clock = new MutableClock("2026-02-22T00:00:00.000Z");
  const repository = new ThreeFcRepository(
    new InMemoryDynamoClient(),
    "threefc_test",
    clock,
  );
  await setupScoringGame(repository);
  clock.set("2026-02-22T00:00:00.000Z");
  await repository.startGameThird({ gameId: "game-1", third: 1 });
  clock.set("2026-02-22T00:20:00.000Z");

  const result = await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-boundary",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-red",
    assistPlayerIds: [],
    ownGoal: false,
  });

  assert.ok(result);
  assert.equal(result.goal.thirdMinute, 20);
  assert.equal(result.goal.gameMinute, 20);
  assert.equal(result.goal.displayTime, "20:00");
  assert.equal(result.goal.stoppageMinute, null);
});

test("repository rejects duplicate goal event IDs without double-counting tallies", async () => {
  const repository = createRepository();
  await setupScoringGame(repository);
  await repository.startGameThird({ gameId: "game-1", third: 1 });

  await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-idem-duplicate",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-red",
    assistPlayerIds: [],
    ownGoal: false,
  });

  await assert.rejects(
    repository.createGoal({
      gameId: "game-1",
      eventId: "goal-idem-duplicate",
      scoringTeamId: "red",
      concedingTeamId: "blue",
      scorerPlayerId: "player-red",
      assistPlayerIds: [],
      ownGoal: false,
      actorUserId: "scorekeeper@example.com",
    }),
    /Goal event has already been created/,
  );

  assert.deepEqual(
    (await repository.listTeamsForGame("game-1")).map((team) => ({
      teamId: team.teamId,
      scored: team.scored,
      conceded: team.conceded,
    })),
    [
      { teamId: "red", scored: 1, conceded: 0 },
      { teamId: "blue", scored: 0, conceded: 1 },
      { teamId: "yellow", scored: 0, conceded: 0 },
    ],
  );
  assert.deepEqual((await repository.listGoalEvents("game-1")).map((goal) => goal.eventId), [
    "goal-idem-duplicate",
  ]);
});

test("repository updates goals, recomputes tallies, and records audit entries", async () => {
  const repository = createRepository();
  await setupScoringGame(repository);
  await repository.startGameThird({ gameId: "game-1", third: 1 });

  await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-correct-own",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: null,
    concedingTeamId: "blue",
    scorerPlayerId: "player-blue",
    assistPlayerIds: [],
    ownGoal: true,
  });

  const result = await repository.updateGoal({
    gameId: "game-1",
    eventId: "goal-correct-own",
    actorUserId: "admin@example.com",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-red",
    assistPlayerIds: ["player-yellow"],
    ownGoal: false,
  });

  assert.ok(result);
  assert.equal(result.goal.eventId, "goal-correct-own");
  assert.equal(result.goal.displayTime, result.previousGoal.displayTime);
  assert.equal(result.goal.scoringTeamId, "red");
  assert.equal(result.goal.ownGoal, false);
  assert.deepEqual(result.goal.assistPlayerIds, ["player-yellow"]);
  assert.deepEqual(
    result.scoreboard.teams.map((team) => ({
      teamId: team.teamId,
      scored: team.scored,
      conceded: team.conceded,
    })),
    [
      { teamId: "red", scored: 1, conceded: 0 },
      { teamId: "blue", scored: 0, conceded: 1 },
      { teamId: "yellow", scored: 0, conceded: 0 },
    ],
  );
  assert.equal(result.audit.action, "goal_updated");
  assert.equal(result.audit.actorUserId, "admin@example.com");
  assert.equal(result.audit.before?.ownGoal, true);
  assert.equal(result.audit.after?.scoringTeamId, "red");
  assert.deepEqual(result.timeline, [result.goal]);
  assert.deepEqual(
    (await repository.listGoalAuditEntries("game-1")).map((entry) => entry.action),
    ["goal_created", "goal_updated"],
  );
});

test("repository allows goal corrections to preserve the original scorer after reassignment", async () => {
  const repository = createRepository();
  await setupScoringGame(repository);
  await repository.startGameThird({ gameId: "game-1", third: 1 });

  await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-historical-scorer",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-red",
    assistPlayerIds: [],
    ownGoal: false,
  });
  await repository.assignRosterPlayer({
    gameId: "game-1",
    teamId: "blue",
    playerId: "player-red",
  });

  const preserved = await repository.updateGoal({
    gameId: "game-1",
    eventId: "goal-historical-scorer",
    actorUserId: "admin@example.com",
    assistPlayerIds: ["player-yellow"],
  });
  assert.equal(preserved?.goal.scorerPlayerId, "player-red");
  assert.equal(preserved?.goal.scoringTeamId, "red");
  assert.deepEqual(preserved?.goal.assistPlayerIds, ["player-yellow"]);

  await assert.rejects(
    repository.updateGoal({
      gameId: "game-1",
      eventId: "goal-historical-scorer",
      actorUserId: "admin@example.com",
      concedingTeamId: "yellow",
      scorerPlayerId: "player-red",
      assistPlayerIds: [],
      ownGoal: false,
    }),
    /Scorer must be rostered on the scoring team/,
  );
});

test("repository normalizes malformed goal audit snapshots to documented response bounds", async () => {
  const { repository, client } = createRepositoryHarness();

  client.seedItem({
    pk: { S: "GAME#game-1" },
    sk: { S: "AUDIT#GOAL#2026-02-22T00:00:00.000Z#audit-legacy" },
    entityType: { S: "goalAudit" },
    createdAt: { S: "2026-02-22T00:00:00.000Z" },
    updatedAt: { S: "2026-02-22T00:00:00.000Z" },
    data: {
      S: JSON.stringify({
        auditId: "audit-legacy",
        gameId: "game-1",
        eventId: "goal-legacy",
        actorUserId: "admin@example.com",
        action: "legacy_unknown",
        before: {
          eventId: "goal-legacy",
          third: 7,
          thirdMinute: 0,
          gameMinute: 0,
          elapsedSeconds: -1,
          stoppageMinute: 0,
          scoringTeamId: "green",
          concedingTeamId: "orange",
          scorerPlayerId: "player-red",
          assistPlayerIds: [123, "player-blue"],
          ownGoal: "false",
        },
        after: null,
      }),
    },
  });

  const [audit] = await repository.listGoalAuditEntries("game-1");
  assert.equal(audit.action, "goal_updated");
  assert.equal(audit.before?.third, 1);
  assert.equal(audit.before?.thirdMinute, 1);
  assert.equal(audit.before?.gameMinute, 1);
  assert.equal(audit.before?.elapsedSeconds, 0);
  assert.equal(audit.before?.stoppageMinute, null);
  assert.equal(audit.before?.displayTime, "1");
  assert.equal(audit.before?.scoringTeamId, null);
  assert.equal(audit.before?.concedingTeamId, "red");
  assert.deepEqual(audit.before?.assistPlayerIds, ["player-blue"]);
  assert.equal(audit.before?.ownGoal, false);
});

test("repository replays duplicate correction operation IDs without duplicate PATCH side effects", async () => {
  const { repository, client } = createRepositoryHarness();
  await setupScoringGame(repository);
  await repository.startGameThird({ gameId: "game-1", third: 1 });

  await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-op-replay",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-red",
    assistPlayerIds: [],
    ownGoal: false,
  });

  const first = await repository.updateGoal({
    gameId: "game-1",
    eventId: "goal-op-replay",
    actorUserId: "scorekeeper@example.com",
    operationId: "correction-op-1",
    operationRequestHash: "hash-1",
    assistPlayerIds: ["player-yellow"],
  });
  const operationItem = client.readItem("GAME#game-1", "GOAL_CORRECTION#correction-op-1");
  assert.ok(operationItem);
  const operationJson = operationItem.data.S;
  if (typeof operationJson !== "string") {
    throw new Error("Expected correction operation data to be stored as JSON.");
  }
  const operationData = JSON.parse(operationJson) as Record<string, unknown>;
  operationItem.data = { S: JSON.stringify({ ...operationData, action: "legacy_unknown" }) };
  client.seedItem(operationItem);

  const storedOperation = await (
    repository as unknown as {
      getGoalCorrectionOperation(
        gameId: string,
        operationId: string,
      ): Promise<{ action: string } | null>;
    }
  ).getGoalCorrectionOperation("game-1", "correction-op-1");
  assert.equal(storedOperation?.action, "goal_updated");

  const second = await repository.updateGoal({
    gameId: "game-1",
    eventId: "goal-op-replay",
    actorUserId: "scorekeeper@example.com",
    operationId: "correction-op-1",
    operationRequestHash: "hash-1",
    assistPlayerIds: ["player-yellow"],
  });

  assert.deepEqual(second, first);
  assert.deepEqual(
    (await repository.listGoalAuditEntries("game-1")).map((entry) => entry.action),
    ["goal_created", "goal_updated"],
  );
  assert.deepEqual((await repository.listGoalEvents("game-1"))[0]?.assistPlayerIds, ["player-yellow"]);

  await assert.rejects(
    repository.updateGoal({
      gameId: "game-1",
      eventId: "goal-op-replay",
      actorUserId: "scorekeeper@example.com",
      operationId: "correction-op-1",
      operationRequestHash: "different-hash",
      assistPlayerIds: [],
    }),
    /different request payload/,
  );
});

test("repository rejects live goal updates when game metadata changes before write", async () => {
  const { repository, client } = createRepositoryHarness();
  await setupScoringGame(repository);
  await repository.startGameThird({ gameId: "game-1", third: 1 });

  await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-live-race-update",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-red",
    assistPlayerIds: [],
    ownGoal: false,
  });

  client.runBeforeNextPut(() => markStoredGameFinished(client, "game-1"));

  await assert.rejects(
    repository.updateGoal({
      gameId: "game-1",
      eventId: "goal-live-race-update",
      actorUserId: "scorekeeper@example.com",
      scoringTeamId: "blue",
      concedingTeamId: "red",
      scorerPlayerId: "player-blue",
      assistPlayerIds: [],
      ownGoal: false,
    }),
    /Goal or scoreboard state changed while updating this goal/,
  );

  const [goal] = await repository.listGoalEvents("game-1");
  assert.equal(goal?.scoringTeamId, "red");
});

test("repository rejects live goal deletes when game metadata changes before write", async () => {
  const { repository, client } = createRepositoryHarness();
  await setupScoringGame(repository);
  await repository.startGameThird({ gameId: "game-1", third: 1 });

  await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-live-race-delete",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-red",
    assistPlayerIds: [],
    ownGoal: false,
  });

  client.runBeforeNextPut(() => markStoredGameFinished(client, "game-1"));

  await assert.rejects(
    repository.deleteGoal({
      gameId: "game-1",
      eventId: "goal-live-race-delete",
      actorUserId: "scorekeeper@example.com",
    }),
    /Goal or scoreboard state changed while deleting this goal/,
  );

  assert.equal((await repository.listGoalEvents("game-1")).length, 1);
});

test("repository deletes goals and recomputes tallies from remaining timeline", async () => {
  const repository = createRepository();
  await setupScoringGame(repository);
  await repository.startGameThird({ gameId: "game-1", third: 1 });

  await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-delete-1",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-red",
    assistPlayerIds: [],
    ownGoal: false,
  });
  await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-delete-2",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: "yellow",
    concedingTeamId: "red",
    scorerPlayerId: "player-yellow",
    assistPlayerIds: [],
    ownGoal: false,
  });

  const result = await repository.deleteGoal({
    gameId: "game-1",
    eventId: "goal-delete-1",
    actorUserId: "scorekeeper@example.com",
  });

  assert.ok(result);
  assert.equal(result.deletedGoal.eventId, "goal-delete-1");
  assert.deepEqual(result.timeline.map((goal) => goal.eventId), ["goal-delete-2"]);
  assert.deepEqual(
    result.scoreboard.teams.map((team) => ({
      teamId: team.teamId,
      scored: team.scored,
      conceded: team.conceded,
    })),
    [
      { teamId: "red", scored: 0, conceded: 1 },
      { teamId: "blue", scored: 0, conceded: 0 },
      { teamId: "yellow", scored: 1, conceded: 0 },
    ],
  );
  assert.equal(result.audit.action, "goal_deleted");
  assert.equal(result.audit.before?.eventId, "goal-delete-1");
  assert.equal(result.audit.after, null);
});

test("repository undo-last deletes only the current latest goal and rejects stale expectations", async () => {
  const repository = createRepository();
  await setupScoringGame(repository);
  await repository.startGameThird({ gameId: "game-1", third: 1 });

  await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-undo-1",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-red",
    assistPlayerIds: [],
    ownGoal: false,
  });
  await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-undo-2",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: "yellow",
    concedingTeamId: "red",
    scorerPlayerId: "player-yellow",
    assistPlayerIds: [],
    ownGoal: false,
  });

  await assert.rejects(
    repository.undoLastGoal({
      gameId: "game-1",
      actorUserId: "scorekeeper@example.com",
      expectedEventId: "",
    }),
    /expectedEventId must be a non-empty string/,
  );

  await assert.rejects(
    repository.undoLastGoal({
      gameId: "game-1",
      actorUserId: "scorekeeper@example.com",
      expectedEventId: "goal-undo-1",
    }),
    /Latest goal changed/,
  );
  assert.deepEqual((await repository.listGoalEvents("game-1")).map((goal) => goal.eventId), [
    "goal-undo-1",
    "goal-undo-2",
  ]);

  const result = await repository.undoLastGoal({
    gameId: "game-1",
    actorUserId: "scorekeeper@example.com",
    expectedEventId: "goal-undo-2",
  });

  assert.ok(result);
  assert.equal(result.deletedGoal.eventId, "goal-undo-2");
  assert.deepEqual(result.timeline.map((goal) => goal.eventId), ["goal-undo-1"]);
  assert.equal(result.audit.action, "goal_undo_last");
  assert.deepEqual(
    result.scoreboard.teams.map((team) => ({
      teamId: team.teamId,
      scored: team.scored,
      conceded: team.conceded,
    })),
    [
      { teamId: "red", scored: 1, conceded: 0 },
      { teamId: "blue", scored: 0, conceded: 1 },
      { teamId: "yellow", scored: 0, conceded: 0 },
    ],
  );
});

test("repository undo-last backfills missing legacy goal state", async () => {
  const { repository, client } = createRepositoryHarness();
  await setupScoringGame(repository);

  for (const goal of [
    {
      eventId: "goal-legacy-1",
      sk: "GOAL#1#0001#0000060#goal-legacy-1",
      elapsedSeconds: 60,
      scoringTeamId: "red",
      concedingTeamId: "blue",
      scorerPlayerId: "player-red",
    },
    {
      eventId: "goal-legacy-2",
      sk: "GOAL#1#0002#0000120#goal-legacy-2",
      elapsedSeconds: 120,
      scoringTeamId: "yellow",
      concedingTeamId: "red",
      scorerPlayerId: "player-yellow",
    },
  ] as const) {
    client.seedItem({
      pk: { S: "GAME#game-1" },
      sk: { S: goal.sk },
      entityType: { S: "goal" },
      createdAt: { S: "2026-02-22T00:00:00.000Z" },
      updatedAt: { S: "2026-02-22T00:00:00.000Z" },
      data: {
        S: JSON.stringify({
          gameId: "game-1",
          eventId: goal.eventId,
          third: 1,
          thirdMinute: Math.floor(goal.elapsedSeconds / 60) + 1,
          gameMinute: Math.floor(goal.elapsedSeconds / 60) + 1,
          elapsedSeconds: goal.elapsedSeconds,
          stoppageMinute: null,
          displayTime: `${String(Math.floor(goal.elapsedSeconds / 60)).padStart(2, "0")}:00`,
          scoringTeamId: goal.scoringTeamId,
          concedingTeamId: goal.concedingTeamId,
          scorerPlayerId: goal.scorerPlayerId,
          assistPlayerIds: [],
          ownGoal: false,
        }),
      },
    });
  }

  const result = await repository.undoLastGoal({
    gameId: "game-1",
    actorUserId: "scorekeeper@example.com",
    expectedEventId: "goal-legacy-2",
  });

  assert.ok(result);
  assert.equal(result.deletedGoal.eventId, "goal-legacy-2");
  assert.deepEqual(result.timeline.map((goal) => goal.eventId), ["goal-legacy-1"]);
  const stateItem = client.readItem("GAME#game-1", "GOAL_STATE");
  assert.ok(stateItem?.data?.S);
  assert.equal(
    (JSON.parse(stateItem.data.S) as { latestEventId: string | null }).latestEventId,
    "goal-legacy-1",
  );
});

test("repository undo-last rejects when strongly read goal-state latest is stale", async () => {
  const { repository, client } = createRepositoryHarness();
  await setupScoringGame(repository);
  await repository.startGameThird({ gameId: "game-1", third: 1 });

  await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-state-1",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: "red",
    concedingTeamId: "blue",
    scorerPlayerId: "player-red",
    assistPlayerIds: [],
    ownGoal: false,
  });
  await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-state-2",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: "yellow",
    concedingTeamId: "red",
    scorerPlayerId: "player-yellow",
    assistPlayerIds: [],
    ownGoal: false,
  });

  const stateItem = client.readItem("GAME#game-1", "GOAL_STATE");
  assert.ok(stateItem?.data?.S);
  const statePayload = JSON.parse(stateItem.data.S) as {
    latestEventId: string | null;
  };
  statePayload.latestEventId = "goal-state-1";
  stateItem.data.S = JSON.stringify(statePayload);
  client.seedItem(stateItem);

  await assert.rejects(
    repository.undoLastGoal({
      gameId: "game-1",
      actorUserId: "scorekeeper@example.com",
      expectedEventId: "goal-state-2",
    }),
    /Latest goal changed/,
  );
  assert.deepEqual((await repository.listGoalEvents("game-1")).map((goal) => goal.eventId), [
    "goal-state-1",
    "goal-state-2",
  ]);
});

test("repository rejects stale scoreboard writes without creating the goal", async () => {
  const { repository, client } = createRepositoryHarness();
  await setupScoringGame(repository);
  await repository.startGameThird({ gameId: "game-1", third: 1 });

  client.runBeforeNextPut(() => {
    const item = client.readItem("GAME#game-1", "TEAM#blue");
    if (!item?.data?.S) {
      throw new Error("Expected blue team item.");
    }

    const data = JSON.parse(item.data.S) as {
      conceded: number;
    };
    data.conceded = 7;
    item.data.S = JSON.stringify(data);
    item.updatedAt = { S: "2026-02-22T00:01:39.000Z" };
    client.seedItem(item);
  });

  await assert.rejects(
    repository.createGoal({
      gameId: "game-1",
      eventId: "goal-stale",
      scoringTeamId: "red",
      concedingTeamId: "blue",
      scorerPlayerId: "player-red",
      assistPlayerIds: [],
      ownGoal: false,
      actorUserId: "scorekeeper@example.com",
    }),
    /Scoreboard changed while creating this goal/,
  );

  assert.deepEqual(await repository.listGoalEvents("game-1"), []);
  assert.equal((await repository.listTeamsForGame("game-1")).find((team) => team.teamId === "blue")?.conceded, 7);
});

test("repository rejects goal creation if game finishes before the goal transaction commits", async () => {
  const { repository, client } = createRepositoryHarness();
  await setupScoringGame(repository);
  await repository.startGameThird({ gameId: "game-1", third: 1 });

  client.runBeforeNextPut(() => {
    const item = client.readItem("GAME#game-1", "METADATA");
    if (!item?.data?.S) {
      throw new Error("Expected game metadata item.");
    }

    const data = JSON.parse(item.data.S) as {
      status: string;
      finishedAt?: string | null;
      result?: unknown;
    };
    data.status = "finished";
    data.finishedAt = "2026-02-22T00:01:39.000Z";
    data.result = {
      winnerTeamId: null,
      outcome: "draw",
      comparator: "fewest_conceded_then_most_scored",
      computedAt: "2026-02-22T00:01:39.000Z",
      teams: [],
    };
    item.data.S = JSON.stringify(data);
    item.updatedAt = { S: "2026-02-22T00:01:39.000Z" };
    client.seedItem(item);
  });

  await assert.rejects(
    repository.createGoal({
      gameId: "game-1",
      eventId: "goal-finish-race",
      scoringTeamId: "red",
      concedingTeamId: "blue",
      scorerPlayerId: "player-red",
      assistPlayerIds: [],
      ownGoal: false,
      actorUserId: "scorekeeper@example.com",
    }),
    /game\/goal state changed/,
  );

  assert.deepEqual(await repository.listGoalEvents("game-1"), []);
  assert.equal((await repository.getGame("game-1"))?.status, "finished");
});

test("repository rethrows non-conditional transaction cancellation when creating goals", async () => {
  const { repository, client } = createRepositoryHarness();
  await setupScoringGame(repository);
  await repository.startGameThird({ gameId: "game-1", third: 1 });

  client.runBeforeNextPut(() => {
    const error = new Error("Transaction validation failed.");
    (
      error as Error & {
        name: string;
        CancellationReasons: Array<{ Code: string }>;
      }
    ).name = "TransactionCanceledException";
    (
      error as Error & {
        name: string;
        CancellationReasons: Array<{ Code: string }>;
      }
    ).CancellationReasons = [{ Code: "ValidationError" }];
    throw error;
  });

  await assert.rejects(
    repository.createGoal({
      gameId: "game-1",
      eventId: "goal-transaction-cancelled",
      scoringTeamId: "red",
      concedingTeamId: "blue",
      scorerPlayerId: "player-red",
      assistPlayerIds: [],
      ownGoal: false,
      actorUserId: "scorekeeper@example.com",
    }),
    /Transaction validation failed/,
  );

  assert.deepEqual(await repository.listGoalEvents("game-1"), []);
});

test("repository own goals increment conceding only and require scorer on conceding team", async () => {
  const repository = createRepository();
  await setupScoringGame(repository);
  await repository.startGameThird({ gameId: "game-1", third: 1 });

  const result = await repository.createGoal({
    gameId: "game-1",
    eventId: "goal-own",
    actorUserId: "scorekeeper@example.com",
    scoringTeamId: null,
    concedingTeamId: "blue",
    scorerPlayerId: "player-blue",
    assistPlayerIds: [],
    ownGoal: true,
  });

  assert.ok(result);
  assert.equal(result.goal.scoringTeamId, null);
  assert.equal(result.goal.ownGoal, true);
  assert.deepEqual(
    result.scoreboard.teams.map((team) => ({
      teamId: team.teamId,
      scored: team.scored,
      conceded: team.conceded,
    })),
    [
      { teamId: "red", scored: 0, conceded: 0 },
      { teamId: "blue", scored: 0, conceded: 1 },
      { teamId: "yellow", scored: 0, conceded: 0 },
    ],
  );

  await assert.rejects(
    repository.createGoal({
      gameId: "game-1",
      eventId: "goal-own-invalid",
      actorUserId: "scorekeeper@example.com",
      scoringTeamId: null,
      concedingTeamId: "blue",
      scorerPlayerId: "player-red",
      assistPlayerIds: [],
      ownGoal: true,
    }),
    /Own-goal scorer must be rostered on the conceding team/,
  );
});

test("repository rejects goal creation unless a third is running", async () => {
  const repository = createRepository();
  await setupScoringGame(repository);

  await assert.rejects(
    repository.createGoal({
      gameId: "game-1",
      eventId: "goal-no-timer",
      actorUserId: "scorekeeper@example.com",
      scoringTeamId: "red",
      concedingTeamId: "blue",
      scorerPlayerId: "player-red",
      assistPlayerIds: [],
      ownGoal: false,
    }),
    /only be created while a third is running/,
  );
});

test("repository validates goal roster and team rules", async () => {
  const repository = createRepository();
  await setupScoringGame(repository);
  await repository.startGameThird({ gameId: "game-1", third: 1 });

  await assert.rejects(
    repository.createGoal({
      gameId: "game-1",
      eventId: "goal-unrostered-scorer",
      actorUserId: "scorekeeper@example.com",
      scoringTeamId: "red",
      concedingTeamId: "blue",
      scorerPlayerId: "player-missing",
      assistPlayerIds: [],
      ownGoal: false,
    }),
    /Scorer must be rostered/,
  );

  await assert.rejects(
    repository.createGoal({
      gameId: "game-1",
      eventId: "goal-wrong-team",
      actorUserId: "scorekeeper@example.com",
      scoringTeamId: "red",
      concedingTeamId: "blue",
      scorerPlayerId: "player-blue",
      assistPlayerIds: [],
      ownGoal: false,
    }),
    /Scorer must be rostered on the scoring team/,
  );

  await assert.rejects(
    repository.createGoal({
      gameId: "game-1",
      eventId: "goal-unrostered-assist",
      actorUserId: "scorekeeper@example.com",
      scoringTeamId: "red",
      concedingTeamId: "blue",
      scorerPlayerId: "player-red",
      assistPlayerIds: ["player-missing"],
      ownGoal: false,
    }),
    /Assist players must be rostered/,
  );
});

test("repository rejects missing partition-key inputs", async () => {
  const repository = createRepository();

  await assert.rejects(
    repository.createLeague({
      leagueId: "",
      name: "Bad League",
      createdByUserId: "user-admin",
    }),
    /leagueId must be a non-empty string/,
  );

  await assert.rejects(
    repository.listGamesForSession(""),
    /sessionId must be a non-empty string/,
  );
});

test("repository enforces goal validation rules", async () => {
  const repository = createRepository();

  await assert.rejects(
    repository.createGoal({
      gameId: "game-1",
      eventId: "goal-invalid",
      actorUserId: "scorekeeper@example.com",
      scoringTeamId: "red",
      concedingTeamId: "blue",
      scorerPlayerId: "player-1",
      assistPlayerIds: ["player-1"],
      ownGoal: false,
    }),
    /Scorer cannot be listed as an assister/,
  );

  await assert.rejects(
    repository.createGoal({
      gameId: "game-1",
      eventId: "goal-own",
      actorUserId: "scorekeeper@example.com",
      scoringTeamId: "red",
      concedingTeamId: "blue",
      scorerPlayerId: "player-1",
      assistPlayerIds: [],
      ownGoal: true,
    }),
    /ownGoal=true requires scoringTeamId to be null/,
  );
});
