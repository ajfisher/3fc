import { createHash } from "node:crypto";

import {
  UpdateItemCommand,
  type AttributeValue,
} from "@aws-sdk/client-dynamodb";

const METADATA_SK = "METADATA";
const ENTITY_TYPE = "authRateLimit";
const MAGIC_LINK_START_SCOPE = "magic-link-start";

export type RateLimitDimension = "email" | "ip";

export interface Clock {
  now(): Date;
}

interface DynamoCommandClient {
  send(command: unknown): Promise<unknown>;
}

export interface MagicLinkRateLimitConfig {
  emailMaxAttempts: number;
  emailWindowSeconds: number;
  ipMaxAttempts: number;
  ipWindowSeconds: number;
}

export interface MagicLinkRateLimitInput {
  email: string;
  clientIp: string;
}

export type RateLimitDecision =
  | { allowed: true }
  | {
      allowed: false;
      dimension: RateLimitDimension;
      retryAfterSeconds: number;
    };

const DEFAULT_MAGIC_LINK_RATE_LIMIT_CONFIG: MagicLinkRateLimitConfig = {
  emailMaxAttempts: 3,
  emailWindowSeconds: 15 * 60,
  ipMaxAttempts: 20,
  ipWindowSeconds: 5 * 60,
};

class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function readPositiveIntegerEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  assertPositiveInteger(name, parsed);
  return parsed;
}

export function readMagicLinkRateLimitConfig(
  env: NodeJS.ProcessEnv = process.env,
): MagicLinkRateLimitConfig {
  return {
    emailMaxAttempts: readPositiveIntegerEnv(
      env,
      "MAGIC_LINK_RATE_LIMIT_EMAIL_MAX_ATTEMPTS",
      DEFAULT_MAGIC_LINK_RATE_LIMIT_CONFIG.emailMaxAttempts,
    ),
    emailWindowSeconds: readPositiveIntegerEnv(
      env,
      "MAGIC_LINK_RATE_LIMIT_EMAIL_WINDOW_SECONDS",
      DEFAULT_MAGIC_LINK_RATE_LIMIT_CONFIG.emailWindowSeconds,
    ),
    ipMaxAttempts: readPositiveIntegerEnv(
      env,
      "MAGIC_LINK_RATE_LIMIT_IP_MAX_ATTEMPTS",
      DEFAULT_MAGIC_LINK_RATE_LIMIT_CONFIG.ipMaxAttempts,
    ),
    ipWindowSeconds: readPositiveIntegerEnv(
      env,
      "MAGIC_LINK_RATE_LIMIT_IP_WINDOW_SECONDS",
      DEFAULT_MAGIC_LINK_RATE_LIMIT_CONFIG.ipWindowSeconds,
    ),
  };
}

function isConditionalCheckFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "ConditionalCheckFailedException"
  );
}

function hashIdentifier(dimension: RateLimitDimension, identifier: string): string {
  return createHash("sha256")
    .update(`${MAGIC_LINK_START_SCOPE}:${dimension}:${identifier}`, "utf8")
    .digest("hex");
}

function rateLimitPk(
  dimension: RateLimitDimension,
  identifier: string,
  windowStartEpoch: number,
): string {
  return [
    "AUTH_RATE_LIMIT",
    MAGIC_LINK_START_SCOPE,
    dimension,
    hashIdentifier(dimension, identifier),
    String(windowStartEpoch),
  ].join("#");
}

function normaliseIdentifier(dimension: RateLimitDimension, identifier: string): string {
  const trimmed = identifier.trim();
  return dimension === "email" ? trimmed.toLowerCase() : trimmed;
}

function buildWindow(nowEpoch: number, windowSeconds: number): {
  windowStartEpoch: number;
  windowExpiresEpoch: number;
  retryAfterSeconds: number;
} {
  const windowStartEpoch = Math.floor(nowEpoch / windowSeconds) * windowSeconds;
  const windowExpiresEpoch = windowStartEpoch + windowSeconds;
  return {
    windowStartEpoch,
    windowExpiresEpoch,
    retryAfterSeconds: Math.max(1, windowExpiresEpoch - nowEpoch),
  };
}

function dimensionConfig(
  dimension: RateLimitDimension,
  config: MagicLinkRateLimitConfig,
): { maxAttempts: number; windowSeconds: number } {
  if (dimension === "email") {
    return {
      maxAttempts: config.emailMaxAttempts,
      windowSeconds: config.emailWindowSeconds,
    };
  }

  return {
    maxAttempts: config.ipMaxAttempts,
    windowSeconds: config.ipWindowSeconds,
  };
}

export class AuthRateLimiter {
  constructor(
    private readonly client: DynamoCommandClient,
    private readonly tableName: string,
    private readonly config: MagicLinkRateLimitConfig = DEFAULT_MAGIC_LINK_RATE_LIMIT_CONFIG,
    private readonly clock: Clock = new SystemClock(),
  ) {
    assertPositiveInteger("emailMaxAttempts", config.emailMaxAttempts);
    assertPositiveInteger("emailWindowSeconds", config.emailWindowSeconds);
    assertPositiveInteger("ipMaxAttempts", config.ipMaxAttempts);
    assertPositiveInteger("ipWindowSeconds", config.ipWindowSeconds);
  }

  async consumeMagicLinkStart(input: MagicLinkRateLimitInput): Promise<RateLimitDecision> {
    const ipDecision = await this.consumeDimension("ip", input.clientIp);
    if (!ipDecision.allowed) {
      return ipDecision;
    }

    return this.consumeDimension("email", input.email);
  }

  private async consumeDimension(
    dimension: RateLimitDimension,
    identifier: string,
  ): Promise<RateLimitDecision> {
    const { maxAttempts, windowSeconds } = dimensionConfig(dimension, this.config);
    const now = this.clock.now();
    const nowEpoch = Math.floor(now.getTime() / 1000);
    const { windowStartEpoch, windowExpiresEpoch, retryAfterSeconds } = buildWindow(
      nowEpoch,
      windowSeconds,
    );
    const normalizedIdentifier = normaliseIdentifier(dimension, identifier || "unknown");

    const values: Record<string, AttributeValue> = {
      ":entityType": { S: ENTITY_TYPE },
      ":scope": { S: MAGIC_LINK_START_SCOPE },
      ":dimension": { S: dimension },
      ":windowStartEpoch": { N: String(windowStartEpoch) },
      ":windowExpiresEpoch": { N: String(windowExpiresEpoch) },
      ":ttlEpoch": { N: String(windowExpiresEpoch) },
      ":createdAt": { S: now.toISOString() },
      ":updatedAt": { S: now.toISOString() },
      ":one": { N: "1" },
      ":maxAttempts": { N: String(maxAttempts) },
    };

    try {
      await this.client.send(
        new UpdateItemCommand({
          TableName: this.tableName,
          Key: {
            pk: { S: rateLimitPk(dimension, normalizedIdentifier, windowStartEpoch) },
            sk: { S: METADATA_SK },
          },
          UpdateExpression: [
            [
              "SET #entityType = if_not_exists(#entityType, :entityType)",
              "#scope = if_not_exists(#scope, :scope)",
              "#dimension = if_not_exists(#dimension, :dimension)",
              "#windowStartEpoch = if_not_exists(#windowStartEpoch, :windowStartEpoch)",
              "#windowExpiresEpoch = if_not_exists(#windowExpiresEpoch, :windowExpiresEpoch)",
              "#ttlEpoch = if_not_exists(#ttlEpoch, :ttlEpoch)",
              "#createdAt = if_not_exists(#createdAt, :createdAt)",
              "#updatedAt = :updatedAt",
            ].join(", "),
            "ADD #attemptCount :one",
          ].join(" "),
          ConditionExpression: "attribute_not_exists(#attemptCount) OR #attemptCount < :maxAttempts",
          ExpressionAttributeNames: {
            "#entityType": "entityType",
            "#scope": "scope",
            "#dimension": "dimension",
            "#windowStartEpoch": "windowStartEpoch",
            "#windowExpiresEpoch": "windowExpiresEpoch",
            "#ttlEpoch": "ttlEpoch",
            "#createdAt": "createdAt",
            "#updatedAt": "updatedAt",
            "#attemptCount": "attemptCount",
          },
          ExpressionAttributeValues: values,
        }),
      );

      return { allowed: true };
    } catch (error) {
      if (isConditionalCheckFailure(error)) {
        return {
          allowed: false,
          dimension,
          retryAfterSeconds,
        };
      }

      throw error;
    }
  }
}
