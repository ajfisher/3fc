import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
  GetItemCommand,
  PutItemCommand,
  TransactWriteItemsCommand,
  type AttributeValue,
  type GetItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { normalizeAppReturnTarget } from "@3fc/contracts";

const MAGIC_TOKEN_PK_PREFIX = "AUTH_MAGIC#";
const SESSION_PK_PREFIX = "AUTH_SESSION#";
const METADATA_SK = "METADATA";
const COMPLETE_SESSION_CANDIDATE_MAX_ATTEMPTS = 3;
const COMPLETE_AMBIGUOUS_RETRY_MAX_ATTEMPTS = 3;
const MAGIC_LINK_TIME_ZONE_MAX_LENGTH = 100;

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

export interface MagicLinkStartOptions {
  returnTo?: string | null;
  subject?: string;
  introLines?: string[];
  timeZone?: string | null;
}

export interface MagicLinkCompleteResult {
  sessionId: string;
  email: string;
  subject: string;
  createdAt: string;
  expiresAt: string;
  maxAgeSeconds: number;
}

export interface AuthSessionRecord {
  sessionId: string;
  email: string;
  subject?: string;
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

export function normalizeMagicLinkEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isMagicLinkEmailLike(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function normalizeMagicLinkTimeZone(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAGIC_LINK_TIME_ZONE_MAX_LENGTH) {
    return null;
  }

  try {
    return new Intl.DateTimeFormat("en-AU", { timeZone: trimmed }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

function hashTokenSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function magicLinkSubjectForEmail(email: string): string {
  const normalizedEmail = normalizeMagicLinkEmail(email);
  const digest = createHash("sha256").update(normalizedEmail, "utf8").digest("base64url");
  return `magic-link:${digest}`;
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

function formatMagicLinkExpiry(expiresAtEpoch: number, timeZone: string | null): string {
  const effectiveTimeZone = timeZone ?? "UTC";
  const expiresAt = new Date(expiresAtEpoch * 1000);
  const timeParts = new Intl.DateTimeFormat("en-AU", {
    timeZone: effectiveTimeZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }).formatToParts(expiresAt);
  const dateParts = new Intl.DateTimeFormat("en-AU", {
    timeZone: effectiveTimeZone,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).formatToParts(expiresAt);
  const timePart = (type: Intl.DateTimeFormatPartTypes): string =>
    timeParts.find((part) => part.type === type)?.value ?? "";
  const datePart = (type: Intl.DateTimeFormatPartTypes): string =>
    dateParts.find((part) => part.type === type)?.value ?? "";
  const zoneName = timeZone === null ? "UTC" : timePart("timeZoneName");

  return `${timePart("hour")}:${timePart("minute")} ${timePart("dayPeriod").toLowerCase()} ${zoneName} on ${datePart("day")} ${datePart("month")} ${datePart("year")}`;
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

function isTransactionCancellation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    ((error as { name?: string }).name === "TransactionCanceledException" ||
      (error as { name?: string }).name === "ConditionalCheckFailedException")
  );
}

function tokenHashesMatch(storedHash: string, presentedHash: string): boolean {
  const stored = Buffer.from(storedHash, "utf8");
  const presented = Buffer.from(presentedHash, "utf8");
  return stored.length === presented.length && timingSafeEqual(stored, presented);
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
}

function buildMagicLinkUrl(
  appBaseUrl: string,
  callbackPath: string,
  token: string,
  returnTo?: string | null,
): string {
  const normalizedBase = appBaseUrl.endsWith("/") ? appBaseUrl.slice(0, -1) : appBaseUrl;
  const normalizedPath = callbackPath.startsWith("/") ? callbackPath : `/${callbackPath}`;
  const query = new URLSearchParams({ token });
  const safeReturnTo = normalizeAppReturnTarget(returnTo);
  if (safeReturnTo) {
    query.set("returnTo", safeReturnTo);
  }
  return `${normalizedBase}${normalizedPath}?${query.toString()}`;
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

  async start(email: string, options: MagicLinkStartOptions = {}): Promise<MagicLinkStartResult> {
    const normalizedEmail = normalizeMagicLinkEmail(email);

    if (!isMagicLinkEmailLike(normalizedEmail)) {
      throw new MagicLinkAuthError("invalid_email", 400, "Email must be a valid email address.");
    }

    const now = this.clock.now();
    const nowIso = asIsoString(now);
    const expiresAtEpoch = Math.floor(now.getTime() / 1000) + this.options.tokenTtlSeconds;
    const expiresAtIso = new Date(expiresAtEpoch * 1000).toISOString();
    const normalizedTimeZone = normalizeMagicLinkTimeZone(options.timeZone);

    const tokenId = this.randomProvider.tokenId();
    const tokenSecret = this.randomProvider.tokenSecret();
    const rawToken = `${tokenId}.${tokenSecret}`;
    const tokenHash = hashTokenSecret(tokenSecret);
    const magicLink = buildMagicLinkUrl(
      this.options.appBaseUrl,
      this.options.callbackPath,
      rawToken,
      options.returnTo,
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

    const hasCustomMessage = options.subject !== undefined || options.introLines !== undefined;
    const emailResponse = await this.emailSender.sendMagicLink(
      hasCustomMessage
        ? {
            to: normalizedEmail,
            subject: options.subject?.trim() || "Your 3FC sign-in link",
            body: [
              ...(options.introLines ?? []),
              ...(options.introLines && options.introLines.length > 0 ? [""] : []),
              "Use this link to sign in to 3FC:",
              magicLink,
              "",
              `This link expires at ${expiresAtIso}.`,
              "If you did not request this email, you can ignore it.",
            ].join("\n"),
          }
        : {
            to: normalizedEmail,
            subject: "Your 3FC sign in magic link",
            body: [
              "Please use the link below to sign into the 3FC app:",
              "",
              magicLink,
              "",
              `This link will expire at ${formatMagicLinkExpiry(expiresAtEpoch, normalizedTimeZone)}`,
              "",
              "If you didn't request this email then you can safely ignore it",
            ].join("\n"),
          },
    );

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

    let tokenItem = await this.getItem(tokenPk(tokenId), true);
    this.assertCompletableToken(tokenItem, tokenHash, nowEpoch);

    const recovered = await this.readLinkedCompletion(tokenItem);
    if (recovered) {
      return recovered;
    }

    const email = readString(tokenItem?.email, "email");
    const subject = magicLinkSubjectForEmail(email);
    const expiresAtEpoch = Math.ceil(now.getTime() / 1000) + this.options.sessionTtlSeconds;
    const expiresAtIso = new Date(expiresAtEpoch * 1000).toISOString();

    let lastTransactionError: unknown;

    for (let attempt = 0; attempt < COMPLETE_SESSION_CANDIDATE_MAX_ATTEMPTS; attempt += 1) {
      const sessionId = this.randomProvider.sessionId();
      const transaction = new TransactWriteItemsCommand({
        ClientRequestToken: sessionId,
        TransactItems: [
          {
            Update: {
              TableName: this.options.tableName,
              Key: {
                pk: { S: tokenPk(tokenId) },
                sk: { S: METADATA_SK },
              },
              UpdateExpression:
                "SET usedAt = :usedAt, updatedAt = :updatedAt, sessionId = :sessionId",
              ConditionExpression:
                "tokenHash = :tokenHash AND attribute_not_exists(usedAt) AND expiresAtEpoch > :nowEpoch",
              ExpressionAttributeValues: {
                ":tokenHash": { S: tokenHash },
                ":usedAt": { S: nowIso },
                ":updatedAt": { S: nowIso },
                ":sessionId": { S: sessionId },
                ":nowEpoch": { N: String(nowEpoch) },
              },
            },
          },
          {
            Put: {
              TableName: this.options.tableName,
              ConditionExpression: "attribute_not_exists(pk)",
              Item: {
                pk: { S: sessionPk(sessionId) },
                sk: { S: METADATA_SK },
                entityType: { S: ENTITY_TYPE.session },
                email: { S: email },
                subject: { S: subject },
                createdAt: { S: nowIso },
                updatedAt: { S: nowIso },
                expiresAtEpoch: { N: String(expiresAtEpoch) },
                ttlEpoch: { N: String(expiresAtEpoch) },
              },
            },
          },
        ],
      });
      let retryWithNewSession = false;

      for (
        let deliveryAttempt = 0;
        deliveryAttempt < COMPLETE_AMBIGUOUS_RETRY_MAX_ATTEMPTS;
        deliveryAttempt += 1
      ) {
        try {
          await this.client.send(transaction);

          return {
            sessionId,
            email,
            subject,
            createdAt: nowIso,
            expiresAt: expiresAtIso,
            maxAgeSeconds: this.options.sessionTtlSeconds,
          };
        } catch (error) {
          lastTransactionError = error;
          tokenItem = await this.getItem(tokenPk(tokenId), true);
          this.assertCompletableToken(tokenItem, tokenHash, nowEpoch);

          const concurrentCompletion = await this.readLinkedCompletion(tokenItem);
          if (concurrentCompletion) {
            return concurrentCompletion;
          }

          if (isTransactionCancellation(error)) {
            retryWithNewSession = true;
            break;
          }

          if (deliveryAttempt + 1 === COMPLETE_AMBIGUOUS_RETRY_MAX_ATTEMPTS) {
            throw error;
          }
        }
      }

      if (!retryWithNewSession) {
        break;
      }
    }

    throw lastTransactionError;
  }

  async getSession(sessionId: string): Promise<AuthSessionRecord | null> {
    if (sessionId.trim().length === 0) {
      return null;
    }

    const item = await this.getItem(sessionPk(sessionId));

    if (!item) {
      return null;
    }

    if (readString(item.entityType, "entityType") !== ENTITY_TYPE.session) {
      return null;
    }

    const nowEpoch = Math.floor(this.clock.now().getTime() / 1000);
    const expiresAtEpoch = readNumber(item.expiresAtEpoch, "expiresAtEpoch");

    if (expiresAtEpoch <= nowEpoch) {
      return null;
    }

    const email = readString(item.email, "email");
    const subject = item.subject?.S ?? magicLinkSubjectForEmail(email);

    return {
      sessionId,
      email,
      subject,
      createdAt: readString(item.createdAt, "createdAt"),
      expiresAt: new Date(expiresAtEpoch * 1000).toISOString(),
    };
  }

  private async getItem(pk: string, consistentRead = false): Promise<Item | undefined> {
    const result = (await this.client.send(
      new GetItemCommand({
        TableName: this.options.tableName,
        Key: {
          pk: { S: pk },
          sk: { S: METADATA_SK },
        },
        ...(consistentRead ? { ConsistentRead: true } : {}),
      }),
    )) as GetItemCommandOutput;

    return result.Item;
  }

  private assertCompletableToken(
    item: Item | undefined,
    presentedTokenHash: string,
    nowEpoch: number,
  ): asserts item is Item {
    if (
      !item ||
      item.entityType?.S !== ENTITY_TYPE.magicToken ||
      item.tokenHash?.S === undefined ||
      !tokenHashesMatch(item.tokenHash.S, presentedTokenHash) ||
      item.expiresAtEpoch?.N === undefined ||
      readNumber(item.expiresAtEpoch, "expiresAtEpoch") <= nowEpoch
    ) {
      throw invalidOrExpiredTokenError();
    }

    if (item.usedAt?.S !== undefined && item.sessionId?.S === undefined) {
      throw invalidOrExpiredTokenError();
    }
  }

  private async readLinkedCompletion(item: Item): Promise<MagicLinkCompleteResult | null> {
    if (item.usedAt?.S === undefined) {
      return null;
    }

    const linkedSessionId = item.sessionId?.S;
    if (!linkedSessionId) {
      throw invalidOrExpiredTokenError();
    }

    const sessionItem = await this.getItem(sessionPk(linkedSessionId), true);
    if (!sessionItem || sessionItem.entityType?.S !== ENTITY_TYPE.session) {
      throw invalidOrExpiredTokenError();
    }

    const email = readString(sessionItem.email, "email");
    if (email !== readString(item.email, "email")) {
      throw invalidOrExpiredTokenError();
    }

    const createdAt = readString(sessionItem.createdAt, "createdAt");
    const expiresAtEpoch = readNumber(sessionItem.expiresAtEpoch, "expiresAtEpoch");
    const createdAtEpoch = Math.ceil(new Date(createdAt).getTime() / 1000);

    return {
      sessionId: linkedSessionId,
      email,
      subject: sessionItem.subject?.S ?? magicLinkSubjectForEmail(email),
      createdAt,
      expiresAt: new Date(expiresAtEpoch * 1000).toISOString(),
      maxAgeSeconds: Math.max(0, expiresAtEpoch - createdAtEpoch),
    };
  }
}
