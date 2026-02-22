import assert from "node:assert/strict";
import test from "node:test";

import {
  PutItemCommand,
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";

import { MagicLinkAuthError, MagicLinkService } from "../auth/magic-link.js";

type Item = Record<string, AttributeValue>;

class InMemoryMagicDynamoClient {
  private readonly items = new Map<string, Item>();

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

    if (command instanceof UpdateItemCommand) {
      const key = command.input.Key;
      const values = command.input.ExpressionAttributeValues ?? {};

      if (!key) {
        throw new Error("UpdateItemCommand is missing Key.");
      }

      const pk = this.readString(key.pk, "pk");
      const sk = this.readString(key.sk, "sk");
      const itemKey = `${pk}|${sk}`;
      const existing = this.items.get(itemKey);

      if (!existing) {
        throw this.conditionalCheckFailed();
      }

      const expectedTokenHash = this.readString(values[":tokenHash"], ":tokenHash");
      const usedAt = this.readString(values[":usedAt"], ":usedAt");
      const updatedAt = this.readString(values[":updatedAt"], ":updatedAt");
      const nowEpoch = this.readNumber(values[":nowEpoch"], ":nowEpoch");

      const storedTokenHash = this.readString(existing.tokenHash, "tokenHash");
      const storedExpiresEpoch = this.readNumber(existing.expiresAtEpoch, "expiresAtEpoch");
      const alreadyUsed = existing.usedAt?.S !== undefined;

      if (
        storedTokenHash !== expectedTokenHash ||
        alreadyUsed ||
        storedExpiresEpoch < nowEpoch
      ) {
        throw this.conditionalCheckFailed();
      }

      const next = {
        ...existing,
        usedAt: { S: usedAt },
        updatedAt: { S: updatedAt },
      };
      this.items.set(itemKey, next);

      return { Attributes: next };
    }

    throw new Error(
      `Unsupported command: ${(command as { constructor?: { name?: string } }).constructor?.name ?? "unknown"}`,
    );
  }

  getItem(pk: string, sk: string): Item | undefined {
    return this.items.get(`${pk}|${sk}`);
  }

  private conditionalCheckFailed(): Error {
    const error = new Error("Conditional check failed");
    (error as Error & { name: string }).name = "ConditionalCheckFailedException";
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

function createHarness() {
  const client = new InMemoryMagicDynamoClient();
  const sentMessages: Array<{ to: string; subject: string; body: string }> = [];
  const clock = new MutableClock(new Date("2026-02-22T00:00:00.000Z"));
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
      sessionTtlSeconds: 3600,
    },
    clock,
    randomProvider,
  );

  return { client, service, sentMessages, clock };
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
});

test("magic complete consumes token once and creates a session", async () => {
  const { client, service, sentMessages } = createHarness();

  await service.start("player@example.com");
  const token = extractTokenFromBody(sentMessages[0].body);

  const firstCompletion = await service.complete(token);
  assert.equal(firstCompletion.sessionId, "session-1");
  assert.equal(firstCompletion.email, "player@example.com");
  assert.equal(firstCompletion.maxAgeSeconds, 3600);

  const tokenItem = client.getItem("AUTH_MAGIC#token-1", "METADATA");
  assert(tokenItem);
  assert.equal(typeof tokenItem.usedAt?.S, "string");

  const sessionItem = client.getItem("AUTH_SESSION#session-1", "METADATA");
  assert(sessionItem);
  assert.equal(sessionItem.email?.S, "player@example.com");

  await assert.rejects(
    service.complete(token),
    (error: unknown) => {
      assert(error instanceof MagicLinkAuthError);
      assert.equal(error.code, "invalid_or_expired_magic_link");
      assert.equal(error.statusCode, 401);
      return true;
    },
  );
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
