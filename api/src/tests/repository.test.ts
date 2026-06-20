import assert from "node:assert/strict";
import test from "node:test";

import {
  DeleteItemCommand,
  GetItemCommand,
  ScanCommand,
  type AttributeValue,
  PutItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import {
  createDefaultThirdTimerSegments,
  DEFAULT_THIRD_LENGTH_MINUTES,
  formatThirdDisplayTime,
} from "@3fc/contracts";

import { ThreeFcRepository } from "../data/repository.js";

type Item = Record<string, AttributeValue>;

class InMemoryDynamoClient {
  private readonly items = new Map<string, Item>();
  private beforeNextPut: (() => void) | null = null;

  seedItem(item: Item): void {
    const pk = this.readString(item.pk, "pk");
    const sk = this.readString(item.sk, "sk");
    this.items.set(`${pk}|${sk}`, item);
  }

  readItem(pk: string, sk: string): Item | undefined {
    return this.items.get(`${pk}|${sk}`);
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
      const item = this.items.get(`${pk}|${sk}`);
      return { Item: item };
    }

    if (command instanceof QueryCommand) {
      const values = command.input.ExpressionAttributeValues ?? {};
      const pk = this.readString(values[":pk"], ":pk");
      const prefix = this.readString(values[":skPrefix"], ":skPrefix");

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
  assert.equal((await repository.listGamePlayers("game-1")).length, 1);

  const reassignedRoster = await repository.assignRosterPlayer({
    gameId: "game-1",
    teamId: "blue",
    playerId: "player-1",
  });
  assert.deepEqual(await repository.listGameRoster("game-1"), [reassignedRoster]);
  assert.equal(reassignedRoster.teamId, "blue");
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
  const repository = createRepository();

  await repository.createGoalEvent({
    gameId: "game-1",
    eventId: "goal-3",
    third: 2,
    gameMinute: 10,
    scoringTeamId: "yellow",
    concedingTeamId: "blue",
    scorerPlayerId: "player-3",
    assistPlayerIds: [],
    ownGoal: false,
  });

  await repository.createGoalEvent({
    gameId: "game-1",
    eventId: "goal-1",
    third: 1,
    gameMinute: 2,
    scoringTeamId: "red",
    concedingTeamId: "yellow",
    scorerPlayerId: "player-1",
    assistPlayerIds: [],
    ownGoal: false,
  });

  await repository.createGoalEvent({
    gameId: "game-1",
    eventId: "goal-2",
    third: 1,
    gameMinute: 8,
    scoringTeamId: "blue",
    concedingTeamId: "red",
    scorerPlayerId: "player-2",
    assistPlayerIds: ["player-4"],
    ownGoal: false,
  });

  const timeline = await repository.listGoalEvents("game-1");
  assert.equal(timeline.length, 3);
  assert.deepEqual(
    timeline.map((goal) => goal.eventId),
    ["goal-1", "goal-2", "goal-3"],
  );
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

test("repository gives legacy games default timer state", async () => {
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
    data.thirds[0].startedAt = "2026-02-22T00:00:99.000Z";
    item.data.S = JSON.stringify(data);
    item.updatedAt = { S: "2026-02-22T00:00:99.000Z" };
    client.seedItem(item);
  });

  await assert.rejects(
    repository.startGameThird({ gameId: "game-1", third: 1 }),
    /Timer state changed while applying this transition/,
  );
  const externallyStarted = await repository.getGame("game-1");
  assert.equal(externallyStarted?.thirds[0].startedAt, "2026-02-22T00:00:99.000Z");

  client.runBeforeNextPut(() => {
    const item = client.readItem("GAME#game-1", "METADATA");
    if (!item?.data?.S) {
      throw new Error("Expected seeded game item.");
    }
    const data = JSON.parse(item.data.S) as {
      thirds: Array<{ third: number; startedAt: string | null; finishedAt: string | null }>;
    };
    data.thirds[0].finishedAt = "2026-02-22T00:01:99.000Z";
    item.data.S = JSON.stringify(data);
    item.updatedAt = { S: "2026-02-22T00:01:99.000Z" };
    client.seedItem(item);
  });

  await assert.rejects(
    repository.finishGameThird({ gameId: "game-1", third: 1 }),
    /Timer state changed while applying this transition/,
  );
  const externallyFinished = await repository.getGame("game-1");
  assert.equal(externallyFinished?.thirds[0].finishedAt, "2026-02-22T00:01:99.000Z");
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
    displayTime: "20+01",
    phase: "stoppage",
    elapsedSeconds: 1200,
    stoppageSeconds: 0,
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
  const repository = createRepository();

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
      thirdLengthMinutes: 20,
    }),
    /Third length cannot be changed after a third has started/,
  );

  await repository.updateGame({
    gameId: "game-1",
    status: "finished",
  });
  await assert.rejects(
    repository.finishGameThird({ gameId: "game-1", third: 1 }),
    /Cannot finish a third after the game is finished/,
  );
});

test("repository rejects third length changes on finished games even before timer starts", async () => {
  const repository = createRepository();

  await repository.createGame({
    gameId: "game-1",
    leagueId: "league-1",
    seasonId: "season-1",
    sessionId: "session-1",
    status: "finished",
    gameStartTs: "2026-02-22T10:00:00Z",
  });

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
  const repository = createRepository();

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

  const record = await repository.getIdempotencyRecord(
    "admin@example.com:POST:/v1/leagues",
    "create-league-1",
  );

  assert.equal(created, true);
  assert.equal(duplicate, false);
  assert.equal(record?.requestHash, "hash-1");
  assert.equal(record?.responseStatusCode, 201);
  assert.equal(record?.responseBody, JSON.stringify({ leagueId: "league-1" }));
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
    repository.createGoalEvent({
      gameId: "game-1",
      eventId: "goal-invalid",
      third: 1,
      gameMinute: 1,
      scoringTeamId: "red",
      concedingTeamId: "blue",
      scorerPlayerId: "player-1",
      assistPlayerIds: ["player-1"],
      ownGoal: false,
    }),
    /Scorer cannot be listed as an assister/,
  );

  await assert.rejects(
    repository.createGoalEvent({
      gameId: "game-1",
      eventId: "goal-own",
      third: 1,
      gameMinute: 1,
      scoringTeamId: "red",
      concedingTeamId: "blue",
      scorerPlayerId: "player-1",
      assistPlayerIds: [],
      ownGoal: true,
    }),
    /ownGoal=true requires scoringTeamId to be null/,
  );
});
