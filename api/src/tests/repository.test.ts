import assert from "node:assert/strict";
import test from "node:test";

import {
  GetItemCommand,
  type AttributeValue,
  PutItemCommand,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";

import { ThreeFcRepository } from "../data/repository.js";

type Item = Record<string, AttributeValue>;

class InMemoryDynamoClient {
  private readonly items = new Map<string, Item>();

  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutItemCommand) {
      const item = command.input.Item;
      if (!item) {
        throw new Error("PutItemCommand is missing Item.");
      }

      const pk = this.readString(item.pk, "pk");
      const sk = this.readString(item.sk, "sk");
      this.items.set(`${pk}|${sk}`, item);
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

    throw new Error(`Unsupported command: ${(command as { constructor?: { name?: string } }).constructor?.name ?? "unknown"}`);
  }

  private readString(value: AttributeValue | undefined, name: string): string {
    if (!value || value.S === undefined) {
      throw new Error(`Missing string attribute ${name}`);
    }

    return value.S;
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

  const player = await repository.createPlayer({
    playerId: "player-1",
    nickname: "AJ",
  });
  assert.deepEqual(await repository.getPlayer("player-1"), player);

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
