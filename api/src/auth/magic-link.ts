import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  GetItemCommand,
  PutItemCommand,
  UpdateItemCommand,
  type AttributeValue,
  type GetItemCommandOutput,
  type UpdateItemCommandOutput,
} from "@aws-sdk/client-dynamodb";

const MAGIC_TOKEN_PK_PREFIX = "AUTH_MAGIC#";
const SESSION_PK_PREFIX = "AUTH_SESSION#";
const METADATA_SK = "METADATA";

const ENTITY_TYPE = {
  magicToken: "magicToken",
  session: "session",
} as const;

type Item = Record<string, AttributeValue>;

interface DynamoCommandClient {
  send(command: unknown): Promise<unknown>;
}

interface RandomProvider {
  tokenId(): string;
  tokenSecret(): string;
  sessionId(): string;
}

export interface Clock {
  now(): Date;
}

export interface MagicLinkEmailSender {
  sendMagicLink(input: { to: string; subject: string; body: string }): Promise<{ messageId?: string }>;
}

export interface MagicLinkServiceOptions {
  tableName: string;
  appBaseUrl: string;
  callbackPath: string;
  tokenTtlSeconds: number;
  sessionTtlSeconds: number;
}

export interface MagicLinkStartResult {
  email: string;
  expiresAt: string;
  messageId: string | null;
}

export interface MagicLinkCompleteResult {
  sessionId: string;
  email: string;
  createdAt: string;
  expiresAt: string;
  maxAgeSeconds: number;
}

export interface AuthSessionRecord {
  sessionId: string;
  email: string;
  createdAt: string;
  expiresAt: string;
}

export class MagicLinkAuthError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "MagicLinkAuthError";
  }
}

class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

class CryptoRandomProvider implements RandomProvider {
  tokenId(): string {
    return randomUUID();
  }

  tokenSecret(): string {
    return randomBytes(32).toString("base64url");
  }

  sessionId(): string {
    return randomUUID();
  }
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function hashTokenSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

function tokenPk(tokenId: string): string {
  return `${MAGIC_TOKEN_PK_PREFIX}${tokenId}`;
}

function sessionPk(sessionId: string): string {
  return `${SESSION_PK_PREFIX}${sessionId}`;
}

function asIsoString(value: Date): string {
  return value.toISOString();
}

function invalidOrExpiredTokenError(): MagicLinkAuthError {
  return new MagicLinkAuthError(
    "invalid_or_expired_magic_link",
    401,
    "Invalid or expired magic link.",
  );
}

function parseMagicToken(rawToken: string): { tokenId: string; tokenSecret: string } {
  const trimmed = rawToken.trim();
  const parts = trimmed.split(".");

  if (parts.length !== 2 || parts[0].length === 0 || parts[1].length === 0) {
    throw invalidOrExpiredTokenError();
  }

  return {
    tokenId: parts[0],
    tokenSecret: parts[1],
  };
}

function readString(value: AttributeValue | undefined, field: string): string {
  if (!value || value.S === undefined) {
    throw new Error(`Missing string attribute \`${field}\`.`);
  }

  return value.S;
}

function readNumber(value: AttributeValue | undefined, field: string): number {
  if (!value || value.N === undefined) {
    throw new Error(`Missing number attribute \`${field}\`.`);
  }

  return Number.parseInt(value.N, 10);
}

function isConditionalCheckFailure(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name?: string }).name === "ConditionalCheckFailedException"
  );
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function buildMagicLinkUrl(appBaseUrl: string, callbackPath: string, token: string): string {
  const normalizedBase = appBaseUrl.endsWith("/") ? appBaseUrl.slice(0, -1) : appBaseUrl;
  const normalizedPath = callbackPath.startsWith("/") ? callbackPath : `/${callbackPath}`;
  const query = new URLSearchParams({ token }).toString();
  return `${normalizedBase}${normalizedPath}?${query}`;
}

export class MagicLinkService {
  private readonly clock: Clock;

  private readonly randomProvider: RandomProvider;

  constructor(
    private readonly client: DynamoCommandClient,
    private readonly emailSender: MagicLinkEmailSender,
    private readonly options: MagicLinkServiceOptions,
    clock: Clock = new SystemClock(),
    randomProvider: RandomProvider = new CryptoRandomProvider(),
  ) {
    assertPositiveInteger("tokenTtlSeconds", options.tokenTtlSeconds);
    assertPositiveInteger("sessionTtlSeconds", options.sessionTtlSeconds);
    this.clock = clock;
    this.randomProvider = randomProvider;
  }

  async start(email: string): Promise<MagicLinkStartResult> {
    const normalizedEmail = normalizeEmail(email);

    if (!isEmailLike(normalizedEmail)) {
      throw new MagicLinkAuthError("invalid_email", 400, "Email must be a valid email address.");
    }

    const now = this.clock.now();
    const nowIso = asIsoString(now);
    const expiresAtEpoch = Math.floor(now.getTime() / 1000) + this.options.tokenTtlSeconds;
    const expiresAtIso = new Date(expiresAtEpoch * 1000).toISOString();

    const tokenId = this.randomProvider.tokenId();
    const tokenSecret = this.randomProvider.tokenSecret();
    const rawToken = `${tokenId}.${tokenSecret}`;
    const tokenHash = hashTokenSecret(tokenSecret);
    const magicLink = buildMagicLinkUrl(
      this.options.appBaseUrl,
      this.options.callbackPath,
      rawToken,
    );

    await this.client.send(
      new PutItemCommand({
        TableName: this.options.tableName,
        ConditionExpression: "attribute_not_exists(pk)",
        Item: {
          pk: { S: tokenPk(tokenId) },
          sk: { S: METADATA_SK },
          entityType: { S: ENTITY_TYPE.magicToken },
          email: { S: normalizedEmail },
          tokenHash: { S: tokenHash },
          expiresAtEpoch: { N: String(expiresAtEpoch) },
          ttlEpoch: { N: String(expiresAtEpoch) },
          createdAt: { S: nowIso },
          updatedAt: { S: nowIso },
        },
      }),
    );

    const emailResponse = await this.emailSender.sendMagicLink({
      to: normalizedEmail,
      subject: "Your 3FC sign-in link",
      body: [
        "Use this link to sign in to 3FC:",
        magicLink,
        "",
        `This link expires at ${expiresAtIso}.`,
        "If you did not request this email, you can ignore it.",
      ].join("\n"),
    });

    return {
      email: normalizedEmail,
      expiresAt: expiresAtIso,
      messageId: emailResponse.messageId ?? null,
    };
  }

  async complete(token: string): Promise<MagicLinkCompleteResult> {
    const { tokenId, tokenSecret } = parseMagicToken(token);
    const tokenHash = hashTokenSecret(tokenSecret);

    const now = this.clock.now();
    const nowIso = asIsoString(now);
    const nowEpoch = Math.floor(now.getTime() / 1000);

    let updatedToken: UpdateItemCommandOutput;

    try {
      updatedToken = (await this.client.send(
        new UpdateItemCommand({
          TableName: this.options.tableName,
          Key: {
            pk: { S: tokenPk(tokenId) },
            sk: { S: METADATA_SK },
          },
          UpdateExpression: "SET usedAt = :usedAt, updatedAt = :updatedAt",
          ConditionExpression:
            "tokenHash = :tokenHash AND attribute_not_exists(usedAt) AND expiresAtEpoch >= :nowEpoch",
          ExpressionAttributeValues: {
            ":tokenHash": { S: tokenHash },
            ":usedAt": { S: nowIso },
            ":updatedAt": { S: nowIso },
            ":nowEpoch": { N: String(nowEpoch) },
          },
          ReturnValues: "ALL_NEW",
        }),
      )) as UpdateItemCommandOutput;
    } catch (error) {
      if (isConditionalCheckFailure(error)) {
        throw invalidOrExpiredTokenError();
      }

      throw error;
    }

    const email = readString(updatedToken.Attributes?.email, "email");
    const sessionId = this.randomProvider.sessionId();
    const expiresAtEpoch = nowEpoch + this.options.sessionTtlSeconds;
    const expiresAtIso = new Date(expiresAtEpoch * 1000).toISOString();

    await this.client.send(
      new PutItemCommand({
        TableName: this.options.tableName,
        ConditionExpression: "attribute_not_exists(pk)",
        Item: {
          pk: { S: sessionPk(sessionId) },
          sk: { S: METADATA_SK },
          entityType: { S: ENTITY_TYPE.session },
          email: { S: email },
          createdAt: { S: nowIso },
          updatedAt: { S: nowIso },
          expiresAtEpoch: { N: String(expiresAtEpoch) },
          ttlEpoch: { N: String(expiresAtEpoch) },
        },
      }),
    );

    return {
      sessionId,
      email,
      createdAt: nowIso,
      expiresAt: expiresAtIso,
      maxAgeSeconds: this.options.sessionTtlSeconds,
    };
  }

  async getSession(sessionId: string): Promise<AuthSessionRecord | null> {
    if (sessionId.trim().length === 0) {
      return null;
    }

    const result = (await this.client.send(
      new GetItemCommand({
        TableName: this.options.tableName,
        Key: {
          pk: { S: sessionPk(sessionId) },
          sk: { S: METADATA_SK },
        },
      }),
    )) as GetItemCommandOutput;

    const item = result.Item;

    if (!item) {
      return null;
    }

    if (readString(item.entityType, "entityType") !== ENTITY_TYPE.session) {
      return null;
    }

    const nowEpoch = Math.floor(this.clock.now().getTime() / 1000);
    const expiresAtEpoch = readNumber(item.expiresAtEpoch, "expiresAtEpoch");

    if (expiresAtEpoch < nowEpoch) {
      return null;
    }

    return {
      sessionId,
      email: readString(item.email, "email"),
      createdAt: readString(item.createdAt, "createdAt"),
      expiresAt: new Date(expiresAtEpoch * 1000).toISOString(),
    };
  }
}
