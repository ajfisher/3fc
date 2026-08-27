import assert from "node:assert/strict";
import test from "node:test";

import {
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";

import {
  magicLinkSubjectForEmail,
  MagicLinkAuthError,
  MagicLinkService,
} from "../auth/magic-link.js";
import { DEFAULT_SESSION_TTL_SECONDS } from "../auth/session.js";

type Item = Record<string, AttributeValue>;

class InMemoryMagicDynamoClient {
  private readonly items = new Map<string, Item>();

  private loseNextTransactionResponse = false;

  private cancelNextTransaction = false;

  private loseNextTransactionResponseBeforeCommit = false;

  private readonly transactionClientTokens: string[] = [];

  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutItemCommand) {
      const item = command.input.Item;

      if (!item) {
        throw new Error("PutItemCommand is missing Item.");
      }

      const pk = this.readString(item.pk, "pk");
      const sk = this.readString(item.sk, "sk");
      const key = `${pk}|${sk}`;

      if (command.input.ConditionExpression === "attribute_not_exists(pk)" && this.items.has(key)) {
        throw this.conditionalCheckFailed();
      }

      this.items.set(key, { ...item });
      return {};
    }

    if (command instanceof TransactWriteItemsCommand) {
      this.transactionClientTokens.push(command.input.ClientRequestToken ?? "");
      const [tokenOperation, sessionOperation] = command.input.TransactItems ?? [];
      const update = tokenOperation?.Update;
      const put = sessionOperation?.Put;

      if (!update?.Key || !put?.Item) {
        throw new Error("Magic-link transaction is missing its token update or session put.");
      }

      const tokenKey = `${this.readString(update.Key.pk, "pk")}|${this.readString(update.Key.sk, "sk")}`;
      const existingToken = this.items.get(tokenKey);
      const values = update.ExpressionAttributeValues ?? {};
      const sessionKey = `${this.readString(put.Item.pk, "pk")}|${this.readString(put.Item.sk, "sk")}`;

      if (!existingToken) {
        throw this.transactionCanceled();
      }

      if (this.loseNextTransactionResponseBeforeCommit) {
        this.loseNextTransactionResponseBeforeCommit = false;
        throw new Error("Simulated ambiguous response loss before the local commit is visible.");
      }

      if (this.cancelNextTransaction) {
        this.cancelNextTransaction = false;
        throw this.transactionCanceled();
      }

      const expectedTokenHash = this.readString(values[":tokenHash"], ":tokenHash");
      const nowEpoch = this.readNumber(values[":nowEpoch"], ":nowEpoch");
      if (
        this.readString(existingToken.tokenHash, "tokenHash") !== expectedTokenHash ||
        existingToken.usedAt?.S !== undefined ||
        this.readNumber(existingToken.expiresAtEpoch, "expiresAtEpoch") <= nowEpoch ||
        this.items.has(sessionKey)
      ) {
        throw this.transactionCanceled();
      }

      this.items.set(tokenKey, {
        ...existingToken,
        usedAt: { S: this.readString(values[":usedAt"], ":usedAt") },
        updatedAt: { S: this.readString(values[":updatedAt"], ":updatedAt") },
        sessionId: { S: this.readString(values[":sessionId"], ":sessionId") },
      });
      this.items.set(sessionKey, { ...put.Item });

      if (this.loseNextTransactionResponse) {
        this.loseNextTransactionResponse = false;
        throw new Error("Simulated response loss after transaction commit.");
      }

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

    throw new Error(
      `Unsupported command: ${(command as { constructor?: { name?: string } }).constructor?.name ?? "unknown"}`,
    );
  }

  getItem(pk: string, sk: string): Item | undefined {
    return this.items.get(`${pk}|${sk}`);
  }

  loseTransactionResponseOnce(): void {
    this.loseNextTransactionResponse = true;
  }

  cancelTransactionOnce(): void {
    this.cancelNextTransaction = true;
  }

  loseTransactionResponseBeforeCommitOnce(): void {
    this.loseNextTransactionResponseBeforeCommit = true;
  }

  getTransactionClientTokens(): string[] {
    return [...this.transactionClientTokens];
  }

  private conditionalCheckFailed(): Error {
    const error = new Error("Conditional check failed");
    (error as Error & { name: string }).name = "ConditionalCheckFailedException";
    return error;
  }

  private transactionCanceled(): Error {
    const error = new Error("Transaction cancelled");
    (error as Error & { name: string }).name = "TransactionCanceledException";
    return error;
  }

  private readString(value: AttributeValue | undefined, field: string): string {
    if (!value || value.S === undefined) {
      throw new Error(`Missing string attribute ${field}`);
    }

    return value.S;
  }

  private readNumber(value: AttributeValue | undefined, field: string): number {
    if (!value || value.N === undefined) {
      throw new Error(`Missing number attribute ${field}`);
    }

    return Number.parseInt(value.N, 10);
  }
}

class MutableClock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

class DeterministicRandomProvider {
  private tokenCounter = 0;

  private sessionCounter = 0;

  tokenId(): string {
    this.tokenCounter += 1;
    return `token-${this.tokenCounter}`;
  }

  tokenSecret(): string {
    return `secret-${this.tokenCounter}`;
  }

  sessionId(): string {
    this.sessionCounter += 1;
    return `session-${this.sessionCounter}`;
  }
}

function extractTokenFromBody(body: string): string {
  const match = body.match(/token=([^\s]+)/);

  if (!match) {
    throw new Error(`No magic token found in body: ${body}`);
  }

  return decodeURIComponent(match[1]);
}

function createHarness(
  sessionTtlSeconds = 3600,
  initialTime = "2026-02-22T00:00:00.000Z",
) {
  const client = new InMemoryMagicDynamoClient();
  const sentMessages: Array<{ to: string; subject: string; body: string }> = [];
  const clock = new MutableClock(new Date(initialTime));
  const randomProvider = new DeterministicRandomProvider();

  const service = new MagicLinkService(
    client,
    {
      async sendMagicLink(input) {
        sentMessages.push(input);
        return { messageId: `msg-${sentMessages.length}` };
      },
    },
    {
      tableName: "threefc_test",
      appBaseUrl: "http://localhost:3000",
      callbackPath: "/auth/callback",
      tokenTtlSeconds: 300,
      sessionTtlSeconds,
    },
    clock,
    randomProvider,
  );

  return { client, service, sentMessages, clock, randomProvider };
}

test("magic start stores TTL token and sends callback link email", async () => {
  const { client, service, sentMessages } = createHarness();

  const result = await service.start("  Player@Example.COM  ");

  assert.equal(result.email, "player@example.com");
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].to, "player@example.com");
  assert.match(sentMessages[0].body, /http:\/\/localhost:3000\/auth\/callback\?token=/);

  const tokenItem = client.getItem("AUTH_MAGIC#token-1", "METADATA");
  assert(tokenItem);
  assert.equal(tokenItem.entityType?.S, "magicToken");
  assert.equal(tokenItem.email?.S, "player@example.com");
  assert.equal(tokenItem.ttlEpoch?.N, tokenItem.expiresAtEpoch?.N);
  assert.equal(tokenItem.tokenSecret, undefined);
});

test("magic start can send invite-specific copy with a safe return target", async () => {
  const { service, sentMessages } = createHarness();

  await service.start("coach@example.com", {
    returnTo: "/invites?code=ABCD2345",
    subject: "You're invited to organise League One on 3FC",
    introLines: ["You have been invited to help organise League One on 3FC."],
  });

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].to, "coach@example.com");
  assert.equal(sentMessages[0].subject, "You're invited to organise League One on 3FC");
  assert.match(sentMessages[0].body, /You have been invited to help organise League One on 3FC\./);
  assert.match(
    sentMessages[0].body,
    /http:\/\/localhost:3000\/auth\/callback\?token=token-1\.secret-1&returnTo=%2Finvites%3Fcode%3DABCD2345/,
  );
});

test("magic start excludes unsafe return targets from callback links", async () => {
  const unsafeTargets = [
    "https://evil.example",
    "//evil.example",
    "/\\evil.example",
    "/%5cevil.example",
    "/auth/callback",
    "/v1/auth/session",
  ];

  for (const returnTo of unsafeTargets) {
    const { service, sentMessages } = createHarness();
    await service.start("coach@example.com", { returnTo });
    assert.doesNotMatch(sentMessages[0].body, /returnTo=/);
  }
});

test("magic complete atomically links one replayable session", async () => {
  const { client, service, sentMessages } = createHarness();

  await service.start("player@example.com");
  const token = extractTokenFromBody(sentMessages[0].body);

  const firstCompletion = await service.complete(token);
  assert.equal(firstCompletion.sessionId, "session-1");
  assert.equal(firstCompletion.email, "player@example.com");
  assert.equal(firstCompletion.subject, magicLinkSubjectForEmail("player@example.com"));
  assert.equal(firstCompletion.maxAgeSeconds, 3600);

  const tokenItem = client.getItem("AUTH_MAGIC#token-1", "METADATA");
  assert(tokenItem);
  assert.equal(typeof tokenItem.usedAt?.S, "string");
  assert.equal(tokenItem.sessionId?.S, "session-1");

  const sessionItem = client.getItem("AUTH_SESSION#session-1", "METADATA");
  assert(sessionItem);
  assert.equal(sessionItem.email?.S, "player@example.com");
  assert.equal(sessionItem.subject?.S, magicLinkSubjectForEmail("player@example.com"));

  const persistedSession = await service.getSession("session-1");
  assert(persistedSession);
  assert.equal(persistedSession.email, "player@example.com");
  assert.equal(persistedSession.subject, magicLinkSubjectForEmail("player@example.com"));

  assert.deepEqual(await service.complete(token), firstCompletion);
  assert.equal(client.getItem("AUTH_SESSION#session-2", "METADATA"), undefined);
});

test("concurrent completions converge on the same persisted session", async () => {
  const { client, service, sentMessages } = createHarness();

  await service.start("concurrent@example.com");
  const token = extractTokenFromBody(sentMessages[0].body);
  const [first, second] = await Promise.all([service.complete(token), service.complete(token)]);

  assert.deepEqual(second, first);
  assert.equal(first.sessionId, "session-1");
  assert(client.getItem("AUTH_SESSION#session-1", "METADATA"));
  assert.equal(client.getItem("AUTH_SESSION#session-2", "METADATA"), undefined);
  assert.equal(client.getItem("AUTH_MAGIC#token-1", "METADATA")?.sessionId?.S, "session-1");
});

test("completion recovers when the transaction commits but its response is lost", async () => {
  const { client, service, sentMessages } = createHarness();

  await service.start("response-loss@example.com");
  const token = extractTokenFromBody(sentMessages[0].body);
  client.loseTransactionResponseOnce();

  const recovered = await service.complete(token);
  assert.equal(recovered.sessionId, "session-1");
  assert.equal(client.getItem("AUTH_MAGIC#token-1", "METADATA")?.sessionId?.S, "session-1");
  assert(client.getItem("AUTH_SESSION#session-1", "METADATA"));
  assert.deepEqual(await service.complete(token), recovered);
});

test("ambiguous transport failure retries the identical idempotent transaction", async () => {
  const { client, service, sentMessages } = createHarness();

  await service.start("ambiguous@example.com");
  const token = extractTokenFromBody(sentMessages[0].body);
  client.loseTransactionResponseBeforeCommitOnce();

  const completed = await service.complete(token);
  assert.equal(completed.sessionId, "session-1");
  assert.deepEqual(client.getTransactionClientTokens(), ["session-1", "session-1"]);
  assert(client.getItem("AUTH_SESSION#session-1", "METADATA"));
  assert.equal(client.getItem("AUTH_SESSION#session-2", "METADATA"), undefined);
});

test("a cancelled transaction leaves the token unused and retries without an orphan session", async () => {
  const { client, service, sentMessages } = createHarness();

  await service.start("transaction-retry@example.com");
  const token = extractTokenFromBody(sentMessages[0].body);
  client.cancelTransactionOnce();

  const completed = await service.complete(token);
  assert.equal(completed.sessionId, "session-2");
  assert.equal(client.getItem("AUTH_SESSION#session-1", "METADATA"), undefined);
  assert(client.getItem("AUTH_SESSION#session-2", "METADATA"));
  assert.equal(client.getItem("AUTH_MAGIC#token-1", "METADATA")?.sessionId?.S, "session-2");
});

test("replay recovery ends at the token persisted expiry", async () => {
  const { service, sentMessages, clock } = createHarness();

  await service.start("replay-expiry@example.com");
  const token = extractTokenFromBody(sentMessages[0].body);
  await service.complete(token);
  clock.advanceSeconds(300);

  await assert.rejects(
    service.complete(token),
    (error: unknown) => {
      assert(error instanceof MagicLinkAuthError);
      assert.equal(error.code, "invalid_or_expired_magic_link");
      return true;
    },
  );
});

test("already-issued tokens use their persisted expiry after configuration changes", async () => {
  const harness = createHarness();

  await harness.service.start("persisted-expiry@example.com");
  const token = extractTokenFromBody(harness.sentMessages[0].body);
  harness.clock.advanceSeconds(120);

  const reconfiguredService = new MagicLinkService(
    harness.client,
    {
      async sendMagicLink(input) {
        harness.sentMessages.push(input);
        return { messageId: `msg-${harness.sentMessages.length}` };
      },
    },
    {
      tableName: "threefc_test",
      appBaseUrl: "http://localhost:3000",
      callbackPath: "/auth/callback",
      tokenTtlSeconds: 1,
      sessionTtlSeconds: 3600,
    },
    harness.clock,
    harness.randomProvider,
  );

  const completion = await reconfiguredService.complete(token);
  assert.equal(completion.sessionId, "session-1");
  assert.equal(completion.email, "persisted-expiry@example.com");
});

test("legacy used tokens without a session link remain invalid", async () => {
  const { client, service, sentMessages } = createHarness();

  await service.start("legacy@example.com");
  const token = extractTokenFromBody(sentMessages[0].body);
  const tokenItem = client.getItem("AUTH_MAGIC#token-1", "METADATA");
  assert(tokenItem);
  tokenItem.usedAt = { S: "2026-02-22T00:00:01.000Z" };

  await assert.rejects(
    service.complete(token),
    (error: unknown) => {
      assert(error instanceof MagicLinkAuthError);
      assert.equal(error.code, "invalid_or_expired_magic_link");
      assert.equal(error.statusCode, 401);
      return true;
    },
  );
  assert.equal(client.getItem("AUTH_SESSION#session-1", "METADATA"), undefined);
});

test("eight-day sessions persist matching expiry and reject at the configured boundary", async () => {
  const { client, service, sentMessages, clock } = createHarness(DEFAULT_SESSION_TTL_SECONDS);

  await service.start("weekly@example.com");
  const token = extractTokenFromBody(sentMessages[0].body);
  const completion = await service.complete(token);

  assert.equal(completion.maxAgeSeconds, 691_200);
  assert.equal(completion.createdAt, "2026-02-22T00:00:00.000Z");
  assert.equal(completion.expiresAt, "2026-03-02T00:00:00.000Z");

  const sessionItem = client.getItem("AUTH_SESSION#session-1", "METADATA");
  assert(sessionItem);
  assert.equal(sessionItem.expiresAtEpoch?.N, "1772409600");
  assert.equal(sessionItem.ttlEpoch?.N, sessionItem.expiresAtEpoch?.N);

  clock.advanceSeconds(DEFAULT_SESSION_TTL_SECONDS - 1);
  assert(await service.getSession("session-1"));
  clock.advanceSeconds(1);
  assert.equal(await service.getSession("session-1"), null);
  assert(client.getItem("AUTH_SESSION#session-1", "METADATA"));
});

test("fractional-second issuance preserves a full eight days at one absolute boundary", async () => {
  const { client, service, sentMessages, clock } = createHarness(
    DEFAULT_SESSION_TTL_SECONDS,
    "2026-02-22T00:00:00.750Z",
  );

  await service.start("fractional@example.com");
  const token = extractTokenFromBody(sentMessages[0].body);
  const completion = await service.complete(token);

  assert.equal(completion.createdAt, "2026-02-22T00:00:00.750Z");
  assert.equal(completion.expiresAt, "2026-03-02T00:00:01.000Z");
  assert.equal(
    client.getItem("AUTH_SESSION#session-1", "METADATA")?.expiresAtEpoch?.N,
    "1772409601",
  );

  clock.advanceSeconds(DEFAULT_SESSION_TTL_SECONDS);
  assert(await service.getSession("session-1"));
  clock.advanceSeconds(0.25);
  assert.equal(await service.getSession("session-1"), null);
});

test("extending the configured lifetime does not rewrite an existing session", async () => {
  const harness = createHarness(86_400);
  await harness.service.start("existing@example.com");
  const existingToken = extractTokenFromBody(harness.sentMessages[0].body);
  const existingCompletion = await harness.service.complete(existingToken);
  assert.equal(existingCompletion.maxAgeSeconds, 86_400);
  assert.equal(existingCompletion.expiresAt, "2026-02-23T00:00:00.000Z");

  const extendedService = new MagicLinkService(
    harness.client,
    {
      async sendMagicLink(input) {
        harness.sentMessages.push(input);
        return { messageId: `msg-${harness.sentMessages.length}` };
      },
    },
    {
      tableName: "threefc_test",
      appBaseUrl: "http://localhost:3000",
      callbackPath: "/auth/callback",
      tokenTtlSeconds: 300,
      sessionTtlSeconds: DEFAULT_SESSION_TTL_SECONDS,
    },
    harness.clock,
    harness.randomProvider,
  );

  assert(await extendedService.getSession("session-1"));
  harness.clock.advanceSeconds(86_399);
  assert(await extendedService.getSession("session-1"));
  harness.clock.advanceSeconds(1);
  assert.equal(await extendedService.getSession("session-1"), null);
  assert.equal(
    harness.client.getItem("AUTH_SESSION#session-1", "METADATA")?.expiresAtEpoch?.N,
    "1771804800",
  );

  await extendedService.start("new@example.com");
  const newToken = extractTokenFromBody(harness.sentMessages.at(-1)?.body ?? "");
  const newCompletion = await extendedService.complete(newToken);
  assert.equal(newCompletion.sessionId, "session-2");
  assert.equal(newCompletion.maxAgeSeconds, 691_200);
  assert.equal(newCompletion.expiresAt, "2026-03-03T00:00:00.000Z");
});

test("session lookup returns null when session is expired", async () => {
  const { service, sentMessages, clock } = createHarness();

  await service.start("player@example.com");
  const token = extractTokenFromBody(sentMessages[0].body);
  await service.complete(token);

  const activeSession = await service.getSession("session-1");
  assert(activeSession);

  clock.advanceSeconds(3601);
  const expiredSession = await service.getSession("session-1");
  assert.equal(expiredSession, null);
});

test("expired token is rejected on completion", async () => {
  const { service, sentMessages, clock } = createHarness();

  await service.start("player@example.com");
  const token = extractTokenFromBody(sentMessages[0].body);

  clock.advanceSeconds(301);

  await assert.rejects(
    service.complete(token),
    (error: unknown) => {
      assert(error instanceof MagicLinkAuthError);
      assert.equal(error.code, "invalid_or_expired_magic_link");
      return true;
    },
  );
});

test("tampered token is rejected on completion", async () => {
  const { service, sentMessages } = createHarness();

  await service.start("player@example.com");
  const token = extractTokenFromBody(sentMessages[0].body);
  const tampered = token.replace("secret-1", "secret-xyz");

  await assert.rejects(
    service.complete(tampered),
    (error: unknown) => {
      assert(error instanceof MagicLinkAuthError);
      assert.equal(error.code, "invalid_or_expired_magic_link");
      return true;
    },
  );
});

test("start rejects invalid email values", async () => {
  const { service } = createHarness();

  await assert.rejects(
    service.start("not-an-email"),
    (error: unknown) => {
      assert(error instanceof MagicLinkAuthError);
      assert.equal(error.code, "invalid_email");
      assert.equal(error.statusCode, 400);
      return true;
    },
  );
});
