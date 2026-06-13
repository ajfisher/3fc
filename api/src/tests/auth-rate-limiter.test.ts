import assert from "node:assert/strict";
import test from "node:test";

import {
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";

import { AuthRateLimiter, type Clock } from "../auth/rate-limit.js";

type Item = Record<string, AttributeValue>;

class InMemoryRateLimitDynamoClient {
  private readonly items = new Map<string, Item>();

  async send(command: unknown): Promise<unknown> {
    if (!(command instanceof UpdateItemCommand)) {
      throw new Error(
        `Unsupported command: ${(command as { constructor?: { name?: string } }).constructor?.name ?? "unknown"}`,
      );
    }

    const key = command.input.Key;
    const values = command.input.ExpressionAttributeValues ?? {};
    const names = command.input.ExpressionAttributeNames ?? {};

    if (!key) {
      throw new Error("UpdateItemCommand is missing Key.");
    }

    const pk = this.readString(key.pk, "pk");
    const sk = this.readString(key.sk, "sk");
    const itemKey = `${pk}|${sk}`;
    const existing = this.items.get(itemKey) ?? {
      pk: { S: pk },
      sk: { S: sk },
    };
    const attemptCountName = names["#attemptCount"] ?? "attemptCount";
    const currentAttemptCount = this.readOptionalNumber(existing[attemptCountName]);
    const maxAttempts = this.readNumber(values[":maxAttempts"], ":maxAttempts");

    if (currentAttemptCount >= maxAttempts) {
      throw this.conditionalCheckFailed();
    }

    const next: Item = { ...existing };
    this.setIfMissing(next, names["#entityType"], values[":entityType"]);
    this.setIfMissing(next, names["#scope"], values[":scope"]);
    this.setIfMissing(next, names["#dimension"], values[":dimension"]);
    this.setIfMissing(next, names["#windowStartEpoch"], values[":windowStartEpoch"]);
    this.setIfMissing(next, names["#windowExpiresEpoch"], values[":windowExpiresEpoch"]);
    this.setIfMissing(next, names["#ttlEpoch"], values[":ttlEpoch"]);
    this.setIfMissing(next, names["#createdAt"], values[":createdAt"]);
    this.setRequired(next, names["#updatedAt"], values[":updatedAt"]);
    next[attemptCountName] = { N: String(currentAttemptCount + 1) };

    this.items.set(itemKey, next);
    return {};
  }

  serializedItems(): string {
    return JSON.stringify([...this.items.entries()]);
  }

  private setIfMissing(item: Item, name: string | undefined, value: AttributeValue | undefined): void {
    if (!name || !value || item[name] !== undefined) {
      return;
    }

    item[name] = value;
  }

  private setRequired(item: Item, name: string | undefined, value: AttributeValue | undefined): void {
    if (!name || !value) {
      throw new Error("Update expression value is missing.");
    }

    item[name] = value;
  }

  private conditionalCheckFailed(): Error {
    const error = new Error("Conditional check failed");
    (error as Error & { name: string }).name = "ConditionalCheckFailedException";
    return error;
  }

  private readString(value: AttributeValue | undefined, name: string): string {
    if (!value || value.S === undefined) {
      throw new Error(`Missing string attribute ${name}`);
    }

    return value.S;
  }

  private readNumber(value: AttributeValue | undefined, name: string): number {
    if (!value || value.N === undefined) {
      throw new Error(`Missing number attribute ${name}`);
    }

    return Number.parseInt(value.N, 10);
  }

  private readOptionalNumber(value: AttributeValue | undefined): number {
    if (!value || value.N === undefined) {
      return 0;
    }

    return Number.parseInt(value.N, 10);
  }
}

class MutableClock implements Clock {
  constructor(private current: Date) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  advanceSeconds(seconds: number): void {
    this.current = new Date(this.current.getTime() + seconds * 1000);
  }
}

function createLimiter(config = {
  emailMaxAttempts: 2,
  emailWindowSeconds: 60,
  ipMaxAttempts: 5,
  ipWindowSeconds: 60,
}) {
  const client = new InMemoryRateLimitDynamoClient();
  const clock = new MutableClock(new Date("2026-03-28T00:00:10.000Z"));
  const limiter = new AuthRateLimiter(client, "threefc_test", config, clock);
  return { client, clock, limiter };
}

test("auth rate limiter allows attempts until the email window is exhausted", async () => {
  const { limiter } = createLimiter();

  assert.deepEqual(
    await limiter.consumeMagicLinkStart({ email: "Player@Example.COM", clientIp: "203.0.113.10" }),
    { allowed: true },
  );
  assert.deepEqual(
    await limiter.consumeMagicLinkStart({ email: "player@example.com", clientIp: "203.0.113.10" }),
    { allowed: true },
  );

  const blocked = await limiter.consumeMagicLinkStart({
    email: "player@example.com",
    clientIp: "203.0.113.10",
  });
  assert.deepEqual(blocked, {
    allowed: false,
    dimension: "email",
    retryAfterSeconds: 50,
  });
});

test("auth rate limiter enforces a separate IP window", async () => {
  const { limiter } = createLimiter({
    emailMaxAttempts: 10,
    emailWindowSeconds: 60,
    ipMaxAttempts: 2,
    ipWindowSeconds: 60,
  });

  assert.deepEqual(
    await limiter.consumeMagicLinkStart({ email: "one@example.com", clientIp: "203.0.113.10" }),
    { allowed: true },
  );
  assert.deepEqual(
    await limiter.consumeMagicLinkStart({ email: "two@example.com", clientIp: "203.0.113.10" }),
    { allowed: true },
  );

  const blocked = await limiter.consumeMagicLinkStart({
    email: "three@example.com",
    clientIp: "203.0.113.10",
  });
  assert.deepEqual(blocked, {
    allowed: false,
    dimension: "ip",
    retryAfterSeconds: 50,
  });
});

test("auth rate limiter starts a new counter after the fixed window rolls over", async () => {
  const { clock, limiter } = createLimiter({
    emailMaxAttempts: 1,
    emailWindowSeconds: 60,
    ipMaxAttempts: 1,
    ipWindowSeconds: 60,
  });

  assert.deepEqual(
    await limiter.consumeMagicLinkStart({ email: "player@example.com", clientIp: "203.0.113.10" }),
    { allowed: true },
  );
  assert.equal(
    (await limiter.consumeMagicLinkStart({ email: "player@example.com", clientIp: "203.0.113.10" }))
      .allowed,
    false,
  );

  clock.advanceSeconds(51);

  assert.deepEqual(
    await limiter.consumeMagicLinkStart({ email: "player@example.com", clientIp: "203.0.113.10" }),
    { allowed: true },
  );
});

test("auth rate limiter stores hashed identifiers only", async () => {
  const { client, limiter } = createLimiter();

  await limiter.consumeMagicLinkStart({ email: "player@example.com", clientIp: "203.0.113.10" });

  const serialized = client.serializedItems();
  assert.equal(serialized.includes("player@example.com"), false);
  assert.equal(serialized.includes("203.0.113.10"), false);
});
