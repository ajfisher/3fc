import {
  DeleteItemCommand,
  DynamoDBClient,
  QueryCommand,
  ScanCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { expect, test, type Locator, type Page } from "@playwright/test";

const apiBaseUrl = process.env.THREEFC_API_BASE_URL ?? "http://localhost:3001";
const fakeSesBaseUrl = process.env.THREEFC_FAKE_SES_BASE_URL ?? "http://localhost:4025";
const dynamodbEndpoint = process.env.THREEFC_DYNAMODB_ENDPOINT ?? "http://localhost:8000";
const dynamodbTableName = process.env.THREEFC_DYNAMODB_TABLE ?? "threefc_local";
const fetchTimeoutMs = 5_000;

interface FakeSesMessage {
  to?: string;
  body?: string;
}

type DynamoItem = Record<string, AttributeValue>;

interface SmokeRunCleanupInput {
  runId: string;
  leagueSlug: string;
  seasonSlug: string;
  gameId: string;
  sessionId: string;
  playerIds: string[];
}

function uniqueRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function scheduleForRun(runId: string): { gameDate: string; kickoff: string } {
  const hash = [...runId].reduce((value, character) => {
    return (value * 33 + character.charCodeAt(0)) >>> 0;
  }, 5381);
  const date = new Date(Date.UTC(2027, 0, 1));
  date.setUTCDate(date.getUTCDate() + (hash % 20_000));
  const gameDate = date.toISOString().slice(0, 10);
  const hour = 8 + (hash % 10);
  const minute = [0, 15, 30, 45][Math.floor(hash / 10) % 4];
  const kickoff = `${gameDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  return { gameDate, kickoff };
}

function createLocalDynamoClient(): DynamoDBClient {
  return new DynamoDBClient({
    region: process.env.AWS_REGION ?? "ap-southeast-2",
    endpoint: dynamodbEndpoint,
    credentials: {
      accessKeyId: "local",
      secretAccessKey: "local",
    },
  });
}

function itemKey(item: DynamoItem): { pk: string; sk: string } | null {
  const pk = item.pk?.S;
  const sk = item.sk?.S;
  return pk && sk ? { pk, sk } : null;
}

function itemSearchText(item: DynamoItem): string {
  return Object.values(item)
    .flatMap((attribute) => [attribute.S, attribute.N, attribute.BOOL?.toString()])
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

async function queryPartition(client: DynamoDBClient, pk: string): Promise<DynamoItem[]> {
  const items: DynamoItem[] = [];
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await client.send(
      new QueryCommand({
        TableName: dynamodbTableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": { S: pk },
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...((response.Items ?? []) as DynamoItem[]));
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items;
}

async function scanTaggedItems(client: DynamoDBClient, needles: string[]): Promise<DynamoItem[]> {
  if (needles.length === 0) {
    return [];
  }

  const items: DynamoItem[] = [];
  let exclusiveStartKey: Record<string, AttributeValue> | undefined;

  do {
    const response = await client.send(
      new ScanCommand({
        TableName: dynamodbTableName,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(
      ...((response.Items ?? []) as DynamoItem[]).filter((item) => {
        const text = itemSearchText(item);
        return needles.some((needle) => text.includes(needle));
      }),
    );
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items;
}

async function deleteItems(client: DynamoDBClient, items: DynamoItem[]): Promise<void> {
  const seen = new Set<string>();

  for (const item of items) {
    const key = itemKey(item);
    if (!key) {
      continue;
    }

    const dedupeKey = `${key.pk}|${key.sk}`;
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);

    await client.send(
      new DeleteItemCommand({
        TableName: dynamodbTableName,
        Key: {
          pk: { S: key.pk },
          sk: { S: key.sk },
        },
      }),
    );
  }
}

async function cleanupSmokeRun(input: SmokeRunCleanupInput): Promise<void> {
  if (process.env.THREEFC_SKIP_SMOKE_CLEANUP === "1") {
    return;
  }

  const client = createLocalDynamoClient();
  try {
    const partitions = [
      `LEAGUE#${input.leagueSlug}`,
      `SEASON#${input.seasonSlug}`,
      ...(input.gameId ? [`GAME#${input.gameId}`] : []),
      ...input.playerIds.filter(Boolean).map((playerId) => `PLAYER#${playerId}`),
    ];

    for (const pk of partitions) {
      await deleteItems(client, await queryPartition(client, pk));
    }

    if (input.sessionId && input.gameId) {
      const sessionPk = `SESSION#${input.sessionId}`;
      const sessionItems = await queryPartition(client, sessionPk);
      await deleteItems(
        client,
        sessionItems.filter((item) => {
          const sk = item.sk?.S ?? "";
          return sk.startsWith("GAME#") && itemSearchText(item).includes(input.gameId);
        }),
      );

      const remainingSessionItems = await queryPartition(client, sessionPk);
      const hasRemainingGameIndexes = remainingSessionItems.some((item) =>
        (item.sk?.S ?? "").startsWith("GAME#"),
      );
      if (!hasRemainingGameIndexes) {
        await deleteItems(
          client,
          remainingSessionItems.filter((item) => item.sk?.S === "METADATA"),
        );
      }
    }

    await deleteItems(
      client,
      await scanTaggedItems(
        client,
        [input.runId, input.leagueSlug, input.seasonSlug, input.gameId].filter(Boolean),
      ),
    );
  } catch (error) {
    console.warn(`M2 smoke cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    client.destroy();
  }
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealthy(url: string): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          const response = await fetchWithTimeout(url);
          return response.ok;
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

async function readFakeSesMessages(): Promise<FakeSesMessage[]> {
  const response = await fetchWithTimeout(`${fakeSesBaseUrl}/messages`);
  if (!response.ok) {
    throw new Error(`Fake SES messages request failed with ${response.status}.`);
  }

  const payload = (await response.json()) as { messages?: FakeSesMessage[] };
  return Array.isArray(payload.messages) ? payload.messages : [];
}

function extractMagicLink(message: FakeSesMessage): string | null {
  const body = message.body ?? "";
  const lineLink = body
    .split(/\r?\n/)
    .find((line) => /^https?:\/\/[^\s]+\/auth\/callback\?token=/.test(line.trim()));
  if (lineLink) {
    return lineLink.trim();
  }

  return body.match(/https?:\/\/[^\s]+\/auth\/callback\?token=[^\s]+/)?.[0] ?? null;
}

async function waitForMagicLink(email: string): Promise<string> {
  let magicLink = "";
  await expect
    .poll(
      async () => {
        const messages = await readFakeSesMessages();
        const message = [...messages].reverse().find((candidate) => candidate.to === email);
        magicLink = message ? extractMagicLink(message) ?? "" : "";
        return magicLink;
      },
      { timeout: 15_000 },
    )
    .not.toBe("");

  return magicLink;
}

async function createAndAssignPlayer(page: Page, nickname: string, teamId: "red" | "blue" | "yellow"): Promise<string> {
  await page.locator("#player-nickname").fill(nickname);
  await page.getByTestId("quick-create-player").click();

  const playerCard = page.locator('[data-ui="roster-player"]').filter({ hasText: nickname }).first();
  await expect(playerCard).toBeVisible();

  const playerId = await playerCard.getAttribute("data-player-id");
  if (!playerId) {
    throw new Error(`Created player ${nickname} did not expose a data-player-id.`);
  }

  await playerCard.locator(`[data-action="assign-player"][data-team-id="${teamId}"]`).click();
  await expect(page.locator(`[data-ui="roster-team"][data-team-id="${teamId}"]`)).toContainText(nickname);

  return playerId;
}

async function startThird(page: Page, third: 1 | 2 | 3): Promise<void> {
  await expect(page.getByTestId("start-third")).toHaveText(`Start Third ${third}`);
  await page.getByTestId("start-third").click();
  await expect(page.locator("#timer-active-third")).toHaveText(`Third ${third}`);
  await expect(page.getByTestId("finish-third")).toHaveText(`Finish Third ${third}`);
}

async function finishThird(page: Page, third: 1 | 2 | 3): Promise<void> {
  await expect(page.getByTestId("finish-third")).toHaveText(`Finish Third ${third}`);
  await page.getByTestId("finish-third").click();
  await expect(page.locator("#third-status-list")).toContainText(`Third ${third}`);
}

async function expectAllDisabled(locator: Locator): Promise<void> {
  const count = await locator.count();
  expect(count).toBeGreaterThan(0);

  for (let index = 0; index < count; index += 1) {
    await expect(locator.nth(index)).toBeDisabled();
  }
}

test.describe("M2 local-stack smoke", () => {
  test.beforeEach(async () => {
    await waitForHealthy(`${apiBaseUrl}/v1/health`);
    await waitForHealthy(`${fakeSesBaseUrl}/health`);
  });

  test("scorekeeper can set up and finish a live game", async ({ page }) => {
    const runId = uniqueRunId();
    const email = `m2-smoke-${runId}@example.com`;
    const leagueSlug = `m2-smoke-league-${runId}`;
    const seasonSlug = `m2-smoke-season-${runId}`;
    const leagueName = `M2 Smoke League ${runId}`;
    const seasonName = `M2 Smoke Season ${runId}`;
    const schedule = scheduleForRun(runId);
    const sessionId = schedule.gameDate.replaceAll("-", "");
    let gameId = "";
    const playerIds: string[] = [];

    try {
      await page.goto("/sign-in?returnTo=%2Fsetup");
      await expect(page.getByTestId("signin-shell")).toBeVisible();
      await page.locator("#auth-email").fill(email);
      await page.getByTestId("send-magic-link").click();
      await expect(page.locator("#auth-status")).toContainText("Magic link sent");

      const magicLink = await waitForMagicLink(email);
      await page.goto(magicLink);
      await page.waitForURL("**/setup");
      await expect(page.getByTestId("setup-shell")).toBeVisible();

      await page.locator("#league-name").fill(leagueName);
      await page.locator("#league-friendly-url").fill(leagueSlug);
      await Promise.all([
        page.waitForURL(`**/leagues/${leagueSlug}`),
        page.getByTestId("create-league").click(),
      ]);
      await expect(page.locator("#league-title")).toHaveText(leagueName);

      await page.locator("#season-name").fill(seasonName);
      await page.locator("#season-friendly-url").fill(seasonSlug);
      await Promise.all([
        page.waitForURL(`**/seasons/${seasonSlug}`),
        page.getByTestId("create-season").click(),
      ]);
      await expect(page.locator("#season-title")).toHaveText(seasonName);

      await page.locator("#game-date").fill(schedule.gameDate);
      await page.locator("#game-date").dispatchEvent("change");
      await page.locator("#game-kickoff").fill(schedule.kickoff);
      await page.locator("#game-kickoff").dispatchEvent("change");
      gameId = (await page.locator("#game-id-display").innerText()).trim();
      expect(gameId).toMatch(/^game-/);

      await Promise.all([
        page.waitForURL(`**/games/${gameId}`),
        page.getByTestId("create-game").click(),
      ]);
      await expect(page.getByTestId("game-shell")).toBeVisible();
      await expect(page.locator("#game-id-value")).toHaveText(gameId);

      const ariPlayerId = await createAndAssignPlayer(page, "Ari", "red");
      playerIds.push(ariPlayerId);
      const beaPlayerId = await createAndAssignPlayer(page, "Bea", "blue");
      playerIds.push(beaPlayerId);

      await startThird(page, 1);
      await page.locator("#goal-scoring-team").selectOption("red");
      await page.locator("#goal-conceding-team").selectOption("blue");
      await page.locator("#goal-scorer").selectOption(ariPlayerId);
      await page.locator(`#goal-assists input[value="${beaPlayerId}"]`).check();
      await page.getByTestId("add-goal").click();

      await expect(page.getByTestId("goal-timeline")).toContainText("Ari for Red");
      await expect(page.getByTestId("goal-timeline")).toContainText("Assists: Bea");
      await expect(page.locator('[data-ui="score-team"][data-team-id="red"]')).toContainText(/Scored\s*1/);
      await expect(page.locator('[data-ui="score-team"][data-team-id="blue"]')).toContainText(/Conceded\s*1/);

      await finishThird(page, 1);
      await startThird(page, 2);
      await finishThird(page, 2);
      await startThird(page, 3);
      await finishThird(page, 3);

      await expect(page.getByTestId("finish-game")).toBeEnabled();
      await page.getByTestId("finish-game").click();

      await expect(page.getByTestId("game-result-summary")).toBeVisible();
      await expect(page.getByTestId("game-result-outcome")).toHaveText("Red win");
      const resultTeams = page.getByTestId("game-result-teams");
      await expect(resultTeams.locator('[data-ui="result-team"][data-team-id="red"]')).toContainText(/Conceded\s*0/);
      await expect(resultTeams.locator('[data-ui="result-team"][data-team-id="red"]')).toContainText(/Scored\s*1/);
      await expect(resultTeams.locator('[data-ui="result-team"][data-team-id="blue"]')).toContainText(/Conceded\s*1/);
      await expect(resultTeams.locator('[data-ui="result-team"][data-team-id="blue"]')).toContainText(/Scored\s*0/);
      await expect(page.locator("#game-edit-status")).toHaveValue("finished");
      await expect(page.getByTestId("finish-game")).toBeDisabled();
      await expect(page.getByTestId("finish-game")).toHaveText("Game finished");
      await expect(page.getByTestId("delete-game")).toBeDisabled();
      await expect(page.getByTestId("quick-create-player")).toBeDisabled();
      await expect(page.getByTestId("add-goal")).toBeDisabled();
      await expectAllDisabled(page.locator('[data-action="assign-player"]'));
      await expectAllDisabled(page.locator('[data-action="edit-goal"]'));
      await expectAllDisabled(page.locator('[data-action="delete-goal"]'));
    } finally {
      await cleanupSmokeRun({
        runId,
        leagueSlug,
        seasonSlug,
        gameId,
        sessionId,
        playerIds,
      });
    }
  });
});
