import {
  DeleteItemCommand,
  DynamoDBClient,
  QueryCommand,
  ScanCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { createHash } from "node:crypto";
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
  email: string;
  leagueSlug: string;
  seasonSlug: string;
  gameId: string;
  sessionId: string;
  playerIds: string[];
  ipRateLimitKeys: DynamoItemKey[];
}

type DynamoClientLike = Pick<DynamoDBClient, "send" | "destroy">;
type RateLimitDimension = "email" | "ip";

interface DynamoItemKey {
  pk: string;
  sk: string;
}

interface AuthRateLimitSnapshot extends DynamoItemKey {
  attemptCount: number;
}

interface SmokeRunCleanupDependencies {
  createClient?: () => DynamoClientLike;
  queryPartition?: (client: DynamoClientLike, pk: string) => Promise<DynamoItem[]>;
  scanTaggedItems?: (client: DynamoClientLike, needles: string[]) => Promise<DynamoItem[]>;
  scanAuthRateLimitItems?: (
    client: DynamoClientLike,
    input: { email: string },
  ) => Promise<DynamoItem[]>;
  decrementAuthRateLimitItems?: (
    client: DynamoClientLike,
    keys: DynamoItemKey[],
  ) => Promise<void>;
  deleteItems?: (client: DynamoClientLike, items: DynamoItem[]) => Promise<void>;
  deleteFakeSesMessages?: (email: string) => Promise<void>;
}

function authRateLimitHash(dimension: RateLimitDimension, identifier: string): string {
  return createHash("sha256")
    .update(`magic-link-start:${dimension}:${identifier}`, "utf8")
    .digest("hex");
}

function authRateLimitDimensionPkPrefix(dimension: RateLimitDimension): string {
  return ["AUTH_RATE_LIMIT", "magic-link-start", dimension, ""].join("#");
}

function authRateLimitPkPrefix(dimension: RateLimitDimension, identifier: string): string {
  const normalizedIdentifier = dimension === "email" ? identifier.trim().toLowerCase() : identifier.trim();
  return [
    "AUTH_RATE_LIMIT",
    "magic-link-start",
    dimension,
    authRateLimitHash(dimension, normalizedIdentifier || "unknown"),
    "",
  ].join("#");
}

function uniqueRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sessionIdForGameDate(gameDate: string): string {
  return gameDate.replaceAll("-", "");
}

function scheduleCandidateForRun(runId: string, probe: number): { gameDate: string; kickoff: string } {
  const hash = [...runId].reduce((value, character) => {
    return (value * 33 + character.charCodeAt(0)) >>> 0;
  }, 5381);
  const date = new Date(Date.UTC(2027, 0, 1));
  date.setUTCDate(date.getUTCDate() + ((hash + probe * 9973) % 20_000));
  const gameDate = date.toISOString().slice(0, 10);
  const hour = 8 + (hash % 10);
  const minute = [0, 15, 30, 45][Math.floor(hash / 10) % 4];
  const kickoff = `${gameDate}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;

  return { gameDate, kickoff };
}

async function scheduleForRun(runId: string): Promise<{ gameDate: string; kickoff: string }> {
  const client = createLocalDynamoClient();
  try {
    for (let probe = 0; probe < 200; probe += 1) {
      const schedule = scheduleCandidateForRun(runId, probe);
      const sessionItems = await queryPartition(client, `SESSION#${sessionIdForGameDate(schedule.gameDate)}`);
      if (sessionItems.length === 0) {
        return schedule;
      }
    }
  } finally {
    client.destroy();
  }

  throw new Error("Could not find an unused smoke-test session date after 200 probes.");
}

function createLocalDynamoClient(): DynamoClientLike {
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

function authRateLimitSnapshotKey(snapshot: DynamoItemKey): string {
  return `${snapshot.pk}|${snapshot.sk}`;
}

function attemptCount(item: DynamoItem): number {
  const rawValue = item.attemptCount?.N;
  if (!rawValue) {
    return 0;
  }

  const parsed = Number.parseInt(rawValue, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function itemSearchText(item: DynamoItem): string {
  return Object.values(item)
    .flatMap((attribute) => [attribute.S, attribute.N, attribute.BOOL?.toString()])
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

async function queryPartition(client: DynamoClientLike, pk: string): Promise<DynamoItem[]> {
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

async function scanTaggedItems(client: DynamoClientLike, needles: string[]): Promise<DynamoItem[]> {
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

async function scanAuthRateLimitItemsForIdentifiers(
  client: DynamoClientLike,
  input: { dimension: RateLimitDimension; identifiers: string[] },
): Promise<DynamoItem[]> {
  const prefixes = input.identifiers.map((identifier) =>
    authRateLimitPkPrefix(input.dimension, identifier),
  );
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
        const pk = item.pk?.S ?? "";
        return item.sk?.S === "METADATA" && prefixes.some((prefix) => pk.startsWith(prefix));
      }),
    );
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items;
}

async function scanAuthRateLimitItemsForDimension(
  client: DynamoClientLike,
  dimension: RateLimitDimension,
): Promise<DynamoItem[]> {
  const prefix = authRateLimitDimensionPkPrefix(dimension);
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
        const pk = item.pk?.S ?? "";
        return item.sk?.S === "METADATA" && pk.startsWith(prefix);
      }),
    );
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey);

  return items;
}

async function scanAuthRateLimitItems(
  client: DynamoClientLike,
  input: { email: string },
): Promise<DynamoItem[]> {
  return scanAuthRateLimitItemsForIdentifiers(client, {
    dimension: "email",
    identifiers: [input.email],
  });
}

async function scanAuthRateLimitSnapshots(
  client: DynamoClientLike,
  input: { dimension: RateLimitDimension; identifiers?: string[] },
): Promise<AuthRateLimitSnapshot[]> {
  const items = input.identifiers
    ? await scanAuthRateLimitItemsForIdentifiers(client, {
        dimension: input.dimension,
        identifiers: input.identifiers,
      })
    : await scanAuthRateLimitItemsForDimension(client, input.dimension);
  return items
    .map((item) => {
      const key = itemKey(item);
      return key ? { ...key, attemptCount: attemptCount(item) } : null;
    })
    .filter((snapshot): snapshot is AuthRateLimitSnapshot => snapshot !== null);
}

async function snapshotLocalAuthRateLimits(input: {
  dimension: RateLimitDimension;
  identifiers?: string[];
}): Promise<AuthRateLimitSnapshot[]> {
  const client = createLocalDynamoClient();
  try {
    return await scanAuthRateLimitSnapshots(client, input);
  } finally {
    client.destroy();
  }
}

function touchedAuthRateLimitKeys(
  before: AuthRateLimitSnapshot[],
  after: AuthRateLimitSnapshot[],
): DynamoItemKey[] {
  const beforeByKey = new Map(
    before.map((snapshot) => [authRateLimitSnapshotKey(snapshot), snapshot.attemptCount]),
  );
  const increased = after
    .map((snapshot) => ({
      pk: snapshot.pk,
      sk: snapshot.sk,
      increase: snapshot.attemptCount - (beforeByKey.get(authRateLimitSnapshotKey(snapshot)) ?? 0),
    }))
    .filter((snapshot) => snapshot.increase > 0);
  const totalIncrease = increased.reduce((sum, snapshot) => sum + snapshot.increase, 0);
  return totalIncrease === 1 ? increased.map(({ pk, sk }) => ({ pk, sk })) : [];
}

function smokeOwnedAuthRateLimitKeys(input: {
  rateLimitConsumed: boolean;
  before: AuthRateLimitSnapshot[];
  after: AuthRateLimitSnapshot[];
}): DynamoItemKey[] {
  if (!input.rateLimitConsumed) {
    return [];
  }

  return touchedAuthRateLimitKeys(input.before, input.after);
}

function didMagicLinkStartConsumeRateLimit(status: number): boolean {
  return status === 202 || status >= 500;
}

function isConditionalCheckFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "ConditionalCheckFailedException"
  );
}

async function decrementAuthRateLimitItem(client: DynamoClientLike, key: DynamoItemKey): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await client.send(
        new UpdateItemCommand({
          TableName: dynamodbTableName,
          Key: {
            pk: { S: key.pk },
            sk: { S: key.sk },
          },
          UpdateExpression: "ADD #attemptCount :minusOne SET #updatedAt = :updatedAt",
          ConditionExpression: "#attemptCount > :one",
          ExpressionAttributeNames: {
            "#attemptCount": "attemptCount",
            "#updatedAt": "updatedAt",
          },
          ExpressionAttributeValues: {
            ":minusOne": { N: "-1" },
            ":one": { N: "1" },
            ":updatedAt": { S: new Date().toISOString() },
          },
        }),
      );
      return;
    } catch (error) {
      if (!isConditionalCheckFailure(error)) {
        throw error;
      }
    }

    try {
      await client.send(
        new DeleteItemCommand({
          TableName: dynamodbTableName,
          Key: {
            pk: { S: key.pk },
            sk: { S: key.sk },
          },
          ConditionExpression: "attribute_not_exists(#attemptCount) OR #attemptCount <= :one",
          ExpressionAttributeNames: {
            "#attemptCount": "attemptCount",
          },
          ExpressionAttributeValues: {
            ":one": { N: "1" },
          },
        }),
      );
      return;
    } catch (error) {
      if (!isConditionalCheckFailure(error)) {
        throw error;
      }
    }
  }

  throw new Error(`Could not safely remove smoke rate-limit attempt for ${key.pk}.`);
}

async function decrementAuthRateLimitItems(
  client: DynamoClientLike,
  keys: DynamoItemKey[],
): Promise<void> {
  const seen = new Set<string>();
  for (const key of keys) {
    const dedupeKey = authRateLimitSnapshotKey(key);
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    await decrementAuthRateLimitItem(client, key);
  }
}

async function deleteItems(client: DynamoClientLike, items: DynamoItem[]): Promise<void> {
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

async function cleanupSmokeRun(
  input: SmokeRunCleanupInput,
  dependencies: SmokeRunCleanupDependencies = {},
): Promise<void> {
  if (process.env.THREEFC_SKIP_SMOKE_CLEANUP === "1") {
    return;
  }

  const createClient = dependencies.createClient ?? createLocalDynamoClient;
  const queryPartitionForCleanup = dependencies.queryPartition ?? queryPartition;
  const scanTaggedItemsForCleanup = dependencies.scanTaggedItems ?? scanTaggedItems;
  const scanAuthRateLimitItemsForCleanup =
    dependencies.scanAuthRateLimitItems ?? scanAuthRateLimitItems;
  const decrementAuthRateLimitItemsForCleanup =
    dependencies.decrementAuthRateLimitItems ?? decrementAuthRateLimitItems;
  const deleteItemsForCleanup = dependencies.deleteItems ?? deleteItems;
  const deleteFakeSesMessagesForCleanup =
    dependencies.deleteFakeSesMessages ?? deleteFakeSesMessages;
  const client = createClient();
  try {
    const runNeedles = [input.runId, input.leagueSlug, input.seasonSlug, input.gameId].filter(Boolean);
    const partitions = [
      `LEAGUE#${input.leagueSlug}`,
      `SEASON#${input.seasonSlug}`,
      ...(input.gameId ? [`GAME#${input.gameId}`] : []),
      ...input.playerIds.filter(Boolean).map((playerId) => `PLAYER#${playerId}`),
    ];

    for (const pk of partitions) {
      await deleteItemsForCleanup(client, await queryPartitionForCleanup(client, pk));
    }

    if (input.sessionId && input.gameId) {
      const sessionPk = `SESSION#${input.sessionId}`;
      const sessionItems = await queryPartitionForCleanup(client, sessionPk);
      await deleteItemsForCleanup(
        client,
        sessionItems.filter((item) => {
          const sk = item.sk?.S ?? "";
          return sk.startsWith("GAME#") && itemSearchText(item).includes(input.gameId);
        }),
      );

      const remainingSessionItems = await queryPartitionForCleanup(client, sessionPk);
      const remainingSessionGameItems = remainingSessionItems.filter((item) =>
        (item.sk?.S ?? "").startsWith("GAME#"),
      );
      const currentSessionMetadata = remainingSessionItems.find((item) => item.sk?.S === "METADATA");
      const metadataBelongsToRun = currentSessionMetadata
        ? runNeedles.some((needle) => itemSearchText(currentSessionMetadata).includes(needle))
        : false;
      if (currentSessionMetadata && metadataBelongsToRun && remainingSessionGameItems.length === 0) {
        await deleteItemsForCleanup(client, [currentSessionMetadata]);
      }
    }

    const taggedItems = await scanTaggedItemsForCleanup(client, runNeedles);
    await deleteItemsForCleanup(
      client,
      taggedItems.filter((item) => {
        const key = itemKey(item);
        return !(key?.pk === `SESSION#${input.sessionId}` && key.sk === "METADATA");
      }),
    );
    await deleteItemsForCleanup(client, await scanAuthRateLimitItemsForCleanup(client, input));
    await decrementAuthRateLimitItemsForCleanup(client, input.ipRateLimitKeys);

    await deleteFakeSesMessagesForCleanup(input.email);
  } finally {
    client.destroy();
  }
}

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), fetchTimeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
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

async function deleteFakeSesMessages(email: string): Promise<void> {
  const response = await fetchWithTimeout(
    `${fakeSesBaseUrl}/messages?to=${encodeURIComponent(email)}`,
    { method: "DELETE" },
  );
  if (!response.ok) {
    throw new Error(`Fake SES message cleanup failed with ${response.status}.`);
  }
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

async function createAndAssignPlayer(
  page: Page,
  nickname: string,
  teamId: "red" | "blue" | "yellow",
  onCreatedPlayerId: (playerId: string) => void,
): Promise<string> {
  await page.locator("#player-nickname").fill(nickname);
  await page.getByTestId("quick-create-player").click();

  const playerCard = page.locator('[data-ui="roster-player"]').filter({ hasText: nickname }).first();
  await expect(playerCard).toBeVisible();

  const playerId = await playerCard.getAttribute("data-player-id");
  if (!playerId) {
    throw new Error(`Created player ${nickname} did not expose a data-player-id.`);
  }
  onCreatedPlayerId(playerId);

  await playerCard.locator(`[data-action="assign-player"][data-team-id="${teamId}"]`).click();
  await expect(page.locator(`[data-ui="roster-team"][data-team-id="${teamId}"]`)).toContainText(nickname);

  return playerId;
}

async function selectGameMode(page: Page, mode: "structure" | "players" | "run" | "final"): Promise<void> {
  await page.getByTestId(`game-mode-${mode}-tab`).click();
  await expect(page.getByTestId(`game-mode-${mode}`)).toBeVisible();
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

async function expectAllEnabled(locator: Locator): Promise<void> {
  const count = await locator.count();
  expect(count).toBeGreaterThan(0);

  for (let index = 0; index < count; index += 1) {
    await expect(locator.nth(index)).toBeEnabled();
  }
}

function testItem(pk: string, sk: string, text: string): DynamoItem {
  return {
    pk: { S: pk },
    sk: { S: sk },
    data: { S: text },
  };
}

test("smoke cleanup removes run-owned records without deleting unrelated session metadata", async () => {
  const runId = "cleanup-run-001";
  const email = "cleanup-run-001@example.com";
  const leagueSlug = "cleanup-league-001";
  const seasonSlug = "cleanup-season-001";
  const gameId = "game-cleanup-001";
  const sessionId = "20270103";
  const playerId = "player-cleanup-001";
  const ipRateLimitKey = {
    pk: "AUTH_RATE_LIMIT#magic-link-start#ip#hash#bucket",
    sk: "METADATA",
  };
  const sessionPk = `SESSION#${sessionId}`;
  const unrelatedSessionMetadata = testItem(
    sessionPk,
    "METADATA",
    "existing real session metadata",
  );
  const partitions = new Map<string, DynamoItem[]>([
    [
      `LEAGUE#${leagueSlug}`,
      [testItem(`LEAGUE#${leagueSlug}`, "METADATA", `owned by ${runId}`)],
    ],
    [
      `SEASON#${seasonSlug}`,
      [testItem(`SEASON#${seasonSlug}`, "METADATA", `owned by ${runId}`)],
    ],
    [
      `GAME#${gameId}`,
      [testItem(`GAME#${gameId}`, "METADATA", `owned by ${runId}`)],
    ],
    [
      `PLAYER#${playerId}`,
      [testItem(`PLAYER#${playerId}`, "PROFILE", `owned by ${runId}`)],
    ],
    [
      sessionPk,
      [
        unrelatedSessionMetadata,
        testItem(sessionPk, `GAME#${gameId}`, `session index for ${gameId}`),
      ],
    ],
    [
      "AUTH_RATE_LIMIT#magic-link-start#email#hash#bucket",
      [
        testItem(
          "AUTH_RATE_LIMIT#magic-link-start#email#hash#bucket",
          "METADATA",
          email,
        ),
      ],
    ],
  ]);
  const deletedKeys = new Set<string>();
  const decrementedRateLimitKeys = new Set<string>();
  let destroyed = false;
  let fakeSesDeletedFor: string | null = null;
  const fakeClient: DynamoClientLike = {
    async send() {
      throw new Error("The cleanup isolation test must use injected Dynamo helpers.");
    },
    destroy() {
      destroyed = true;
    },
  };

  await cleanupSmokeRun(
    {
      runId,
      email,
      leagueSlug,
      seasonSlug,
      gameId,
      sessionId,
      playerIds: [playerId],
      ipRateLimitKeys: [ipRateLimitKey],
    },
    {
      createClient: () => fakeClient,
      async queryPartition(_client, pk) {
        return [...(partitions.get(pk) ?? [])];
      },
      async scanTaggedItems(_client, needles) {
        return [...partitions.values()]
          .flat()
          .filter((item) => needles.some((needle) => itemSearchText(item).includes(needle)));
      },
      async scanAuthRateLimitItems() {
        return partitions.get("AUTH_RATE_LIMIT#magic-link-start#email#hash#bucket") ?? [];
      },
      async decrementAuthRateLimitItems(_client, keys) {
        for (const key of keys) {
          decrementedRateLimitKeys.add(`${key.pk}|${key.sk}`);
        }
      },
      async deleteItems(_client, items) {
        for (const item of items) {
          const key = itemKey(item);
          if (!key) {
            continue;
          }

          deletedKeys.add(`${key.pk}|${key.sk}`);
          partitions.set(
            key.pk,
            (partitions.get(key.pk) ?? []).filter((candidate) => {
              const candidateKey = itemKey(candidate);
              return candidateKey?.sk !== key.sk;
            }),
          );
        }
      },
      async deleteFakeSesMessages(deletedEmail) {
        fakeSesDeletedFor = deletedEmail;
      },
    },
  );

  expect(deletedKeys).toContain(`LEAGUE#${leagueSlug}|METADATA`);
  expect(deletedKeys).toContain(`SEASON#${seasonSlug}|METADATA`);
  expect(deletedKeys).toContain(`GAME#${gameId}|METADATA`);
  expect(deletedKeys).toContain(`PLAYER#${playerId}|PROFILE`);
  expect(deletedKeys).toContain(`${sessionPk}|GAME#${gameId}`);
  expect(deletedKeys).toContain("AUTH_RATE_LIMIT#magic-link-start#email#hash#bucket|METADATA");
  expect(decrementedRateLimitKeys).toContain(`${ipRateLimitKey.pk}|${ipRateLimitKey.sk}`);
  expect(deletedKeys).not.toContain(`${sessionPk}|METADATA`);
  expect(partitions.get(sessionPk)).toEqual([unrelatedSessionMetadata]);
  expect(fakeSesDeletedFor).toBe(email);
  expect(destroyed).toBe(true);
});

test("smoke cleanup detects consumed IP rate-limit buckets without known client addresses", async () => {
  const beforeClient: DynamoClientLike = {
    async send(command) {
      expect(command).toBeInstanceOf(ScanCommand);
      return {
        Items: [
          {
            pk: { S: "AUTH_RATE_LIMIT#magic-link-start#ip#docker-bridge-hash#bucket" },
            sk: { S: "METADATA" },
            attemptCount: { N: "2" },
          },
          {
            pk: { S: "AUTH_RATE_LIMIT#magic-link-start#ip#unrelated-hash#bucket" },
            sk: { S: "METADATA" },
            attemptCount: { N: "4" },
          },
          {
            pk: { S: "AUTH_RATE_LIMIT#magic-link-start#email#email-hash#bucket" },
            sk: { S: "METADATA" },
            attemptCount: { N: "9" },
          },
        ],
      };
    },
    destroy() {},
  };
  const afterClient: DynamoClientLike = {
    async send(command) {
      expect(command).toBeInstanceOf(ScanCommand);
      return {
        Items: [
          {
            pk: { S: "AUTH_RATE_LIMIT#magic-link-start#ip#docker-bridge-hash#bucket" },
            sk: { S: "METADATA" },
            attemptCount: { N: "3" },
          },
          {
            pk: { S: "AUTH_RATE_LIMIT#magic-link-start#ip#unrelated-hash#bucket" },
            sk: { S: "METADATA" },
            attemptCount: { N: "4" },
          },
          {
            pk: { S: "AUTH_RATE_LIMIT#magic-link-start#email#email-hash#bucket" },
            sk: { S: "METADATA" },
            attemptCount: { N: "10" },
          },
        ],
      };
    },
    destroy() {},
  };

  const before = await scanAuthRateLimitSnapshots(beforeClient, { dimension: "ip" });
  const after = await scanAuthRateLimitSnapshots(afterClient, { dimension: "ip" });

  expect(before).toEqual([
    {
      pk: "AUTH_RATE_LIMIT#magic-link-start#ip#docker-bridge-hash#bucket",
      sk: "METADATA",
      attemptCount: 2,
    },
    {
      pk: "AUTH_RATE_LIMIT#magic-link-start#ip#unrelated-hash#bucket",
      sk: "METADATA",
      attemptCount: 4,
    },
  ]);
  expect(smokeOwnedAuthRateLimitKeys({ rateLimitConsumed: true, before, after })).toEqual([
    {
      pk: "AUTH_RATE_LIMIT#magic-link-start#ip#docker-bridge-hash#bucket",
      sk: "METADATA",
    },
  ]);
  expect(
    smokeOwnedAuthRateLimitKeys({
      rateLimitConsumed: true,
      before,
      after: [
        ...after,
        {
          pk: "AUTH_RATE_LIMIT#magic-link-start#ip#concurrent-hash#bucket",
          sk: "METADATA",
          attemptCount: 1,
        },
      ],
    }),
  ).toEqual([]);
  expect(
    smokeOwnedAuthRateLimitKeys({
      rateLimitConsumed: false,
      before,
      after: [
        {
          pk: "AUTH_RATE_LIMIT#magic-link-start#ip#docker-bridge-hash#bucket",
          sk: "METADATA",
          attemptCount: 2,
        },
        {
          pk: "AUTH_RATE_LIMIT#magic-link-start#ip#unrelated-hash#bucket",
          sk: "METADATA",
          attemptCount: 5,
        },
      ],
    }),
  ).toEqual([]);
});

test("smoke cleanup tracks magic-link consumption separately from final response status", () => {
  expect(didMagicLinkStartConsumeRateLimit(202)).toBe(true);
  expect(didMagicLinkStartConsumeRateLimit(500)).toBe(true);
  expect(didMagicLinkStartConsumeRateLimit(400)).toBe(false);
  expect(didMagicLinkStartConsumeRateLimit(403)).toBe(false);
  expect(didMagicLinkStartConsumeRateLimit(429)).toBe(false);
});

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
    const ariNickname = `Ari ${runId}`;
    const beaNickname = `Bea ${runId}`;
    const schedule = await scheduleForRun(runId);
    const sessionId = sessionIdForGameDate(schedule.gameDate);
    let gameId = "";
    const playerIds: string[] = [];
    const initialIpRateLimits = await snapshotLocalAuthRateLimits({ dimension: "ip" });
    let magicLinkStartConsumedRateLimit = false;

    let testFailed = false;
    try {
      await page.goto("/sign-in?returnTo=%2Fsetup");
      await expect(page.getByTestId("signin-shell")).toBeVisible();
      await page.locator("#auth-email").fill(email);
      const magicStartResponsePromise = page.waitForResponse((response) =>
        response.url().startsWith(`${apiBaseUrl}/v1/auth/magic/start`) &&
        response.request().method() === "POST",
      );
      await page.getByTestId("send-magic-link").click();
      const magicStartResponse = await magicStartResponsePromise;
      magicLinkStartConsumedRateLimit = didMagicLinkStartConsumeRateLimit(magicStartResponse.status());
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

      await Promise.all([page.waitForURL(/\/games\/[^/]+$/), page.getByTestId("create-game").click()]);
      gameId = decodeURIComponent(new URL(page.url()).pathname.split("/").filter(Boolean).at(-1) ?? "");
      expect(gameId).toMatch(/^game-/);
      await expect(page.getByTestId("game-shell")).toBeVisible();
      await expect(page.locator("#game-id-value")).toHaveText(gameId);
      await expect(page.locator("#game-title")).not.toHaveText(gameId);
      await expect(page.getByTestId("game-mode-structure")).toBeVisible();
      await expect(page.getByTestId("game-mode-players")).toBeHidden();
      const joinCodeValue = page.getByTestId("game-join-code-value");
      await expect(joinCodeValue).toHaveText(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
      const joinCode = (await joinCodeValue.innerText()).trim();
      expect(joinCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);

      const joinResult = await page.evaluate(
        async ({ apiBaseUrl: browserApiBaseUrl, joinCode: browserJoinCode }) => {
          const response = await fetch(`${browserApiBaseUrl}/v1/join/${encodeURIComponent(browserJoinCode)}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({ nickname: "Cy" }),
          });
          const responseText = await response.text();
          type JoinRegistrationSmokeBody = {
            gameId?: string;
            joinCode?: string;
            player?: { nickname?: string; playerId?: string };
            rawBody?: string;
          };
          let body: JoinRegistrationSmokeBody;
          try {
            body = responseText
              ? (JSON.parse(responseText) as JoinRegistrationSmokeBody)
              : {};
          } catch {
            body = { rawBody: responseText };
          }
          return {
            status: response.status,
            body,
          };
        },
        { apiBaseUrl, joinCode },
      );
      expect(joinResult.status).toBe(201);
      expect(joinResult.body.gameId).toBe(gameId);
      expect(joinResult.body.joinCode).toBe(joinCode);
      expect(joinResult.body.player?.nickname).toBe("Cy");
      if (joinResult.body.player?.playerId) {
        playerIds.push(joinResult.body.player.playerId);
      }

      await selectGameMode(page, "players");
      await page.locator("#player-search").fill("Cy");
      await expect(page.locator('[data-ui="roster-player"]').filter({ hasText: "Cy" })).toBeVisible();
      await page.locator("#player-search").fill("");

      const ariPlayerId = await createAndAssignPlayer(page, ariNickname, "red", (playerId) => {
        playerIds.push(playerId);
      });
      const beaPlayerId = await createAndAssignPlayer(page, beaNickname, "blue", (playerId) => {
        playerIds.push(playerId);
      });

      await selectGameMode(page, "run");
      await expect(page.getByTestId("add-goal")).toBeVisible();
      await expect(page.getByTestId("undo-last-goal")).toBeVisible();
      await startThird(page, 1);
      await page.locator("#goal-scoring-team").selectOption("red");
      await page.locator("#goal-conceding-team").selectOption("blue");
      await page.locator("#goal-scorer").selectOption(ariPlayerId);
      await page.locator(`#goal-assists input[value="${beaPlayerId}"]`).check();
      await page.getByTestId("add-goal").click();

      await expect(page.getByTestId("goal-timeline")).toContainText(`${ariNickname} for Red`);
      await expect(page.getByTestId("goal-timeline")).toContainText(`Assists: ${beaNickname}`);
      await expect(page.locator('[data-ui="score-team"][data-team-id="red"]')).toContainText(/Scored\s*1/);
      await expect(page.locator('[data-ui="score-team"][data-team-id="blue"]')).toContainText(/Conceded\s*1/);

      await finishThird(page, 1);
      await startThird(page, 2);
      await finishThird(page, 2);
      await startThird(page, 3);
      await finishThird(page, 3);

      await expect(page.getByTestId("game-mode-final")).toBeVisible();
      await expect(page.getByTestId("finish-game")).toBeEnabled();
      await page.getByTestId("finish-game").click();

      await expect(page.getByTestId("game-result-summary")).toBeVisible();
      await expect(page.getByTestId("game-result-outcome")).toHaveText("Red win");
      const resultTeams = page.getByTestId("game-result-teams");
      await expect(resultTeams.locator('[data-ui="result-team"][data-team-id="red"]')).toContainText(/Conceded\s*0/);
      await expect(resultTeams.locator('[data-ui="result-team"][data-team-id="red"]')).toContainText(/Scored\s*1/);
      await expect(resultTeams.locator('[data-ui="result-team"][data-team-id="blue"]')).toContainText(/Conceded\s*1/);
      await expect(resultTeams.locator('[data-ui="result-team"][data-team-id="blue"]')).toContainText(/Scored\s*0/);
      await expect(page.getByTestId("final-team-log-red")).toContainText(ariNickname);
      await expect(page.getByTestId("final-scorer-stats").locator("li").filter({ hasText: ariNickname })).toContainText("1");
      await expect(page.getByTestId("final-assist-stats").locator("li").filter({ hasText: beaNickname })).toContainText("1");
      await expect(page.getByTestId("final-full-goal-log")).toContainText(ariNickname);
      await expect(page.locator("#game-edit-status")).toHaveValue("finished");
      await expect(page.getByTestId("finish-game")).toBeDisabled();
      await expect(page.getByTestId("finish-game")).toHaveText("Game finished");
      await expect(page.getByTestId("delete-game")).toBeDisabled();
      await selectGameMode(page, "players");
      await expect(page.getByTestId("quick-create-player")).toBeEnabled();
      await expectAllEnabled(page.locator('[data-action="assign-player"]'));
      await selectGameMode(page, "run");
      await expect(page.getByTestId("add-goal")).toBeEnabled();
      await expect(page.locator("#goal-form-note")).toContainText("final whistle");
      await expect(page.locator('[data-action="edit-goal"]').first()).toBeEnabled();
      await expect(page.locator('[data-action="delete-goal"]').first()).toBeEnabled();
      await expect(page.getByTestId("undo-last-goal")).toBeEnabled();
    } catch (error) {
      testFailed = true;
      throw error;
    } finally {
      try {
        const currentIpRateLimits = magicLinkStartConsumedRateLimit
          ? await snapshotLocalAuthRateLimits({ dimension: "ip" })
          : [];
        await cleanupSmokeRun({
          runId,
          email,
          leagueSlug,
          seasonSlug,
          gameId,
          sessionId,
          playerIds,
          ipRateLimitKeys: smokeOwnedAuthRateLimitKeys({
            rateLimitConsumed: magicLinkStartConsumedRateLimit,
            before: initialIpRateLimits,
            after: currentIpRateLimits,
          }),
        });
      } catch (error) {
        if (!testFailed) {
          throw error;
        }
        console.warn(`M2 smoke cleanup failed after test failure: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  });
});
