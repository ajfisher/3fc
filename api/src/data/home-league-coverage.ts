import { GetItemCommand, ScanCommand, TransactWriteItemsCommand,
  type AttributeValue, type GetItemCommandOutput, type ScanCommandOutput, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { randomUUID } from "node:crypto";
import { HOME_LOOKUP_WRITER_VERSION, homeAccountPk, homeLeagueSk, homeLeagueLookupPut } from "./home-league-lookup.js";
import { identityCondition, identityPut, boundedIdentityTransaction, type IdentityClient, type IdentitySnapshot } from "./player-identity.js";
import type { IdentityMigrationManifest } from "./player-identity-migration.js";
import type { LeagueAclRecord } from "./types.js";

type Item = Record<string, AttributeValue>;
export type HomeLeagueManifest = Omit<IdentityMigrationManifest, "writerVersion"> & { writerVersion: number };
export interface HomeLeagueCoverage {
  version: 1; epoch: string; manifest: HomeLeagueManifest;
  phase: "backfill" | "verification" | "ready" | "disabled";
  cursor: { pk: string; sk: string } | null;
  pages: number; repaired: number; verified: number;
}
const pk = "HOME_LOOKUP", sk = "CONTROL", entityType = "homeLeagueCoverage";
function fail(): never { throw new Error("Home lookup coverage needs operator reconciliation."); }
const text = (v: unknown): v is string => typeof v === "string" && v.length > 0;
function validKey(v: unknown): v is { pk: string; sk: string } {
  const key = v as { pk?: unknown; sk?: unknown } | null;
  return Boolean(key && text(key.pk) && text(key.sk) && Buffer.byteLength(key.pk) <= 2048 && Buffer.byteLength(key.sk) <= 1024);
}
function manifestValid(v: HomeLeagueManifest): boolean {
  return Boolean(v && /^[a-zA-Z0-9-]{8,80}$/.test(v.migrationId) && /^\d{12}$/.test(v.accountId) &&
    /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(v.region) && /^[A-Za-z0-9_.-]{3,255}$/.test(v.tableName) &&
    v.tableArn === `arn:aws:dynamodb:${v.region}:${v.accountId}:table/${v.tableName}` &&
    /^[a-f0-9]{40}$/.test(v.writerSha) && Number.isSafeInteger(v.writerVersion) && v.writerVersion > 0 && Number.isFinite(Date.parse(v.drainedAt)) &&
    /^https:\/\/github\.com\/ajfisher\/3fc\/(?:pull|issues)\/\d+(?:#[-\w]+)?$/.test(v.reviewedPlan));
}
export function validHomeLeagueCoverage(value: unknown, tableName: string): value is HomeLeagueCoverage {
  const v = value as HomeLeagueCoverage | null;
  return Boolean(v && v.version === 1 && manifestValid(v.manifest) && v.manifest.tableName === tableName && text(v.epoch) &&
    ["backfill", "verification", "ready", "disabled"].includes(v.phase) &&
    (v.cursor === null || validKey(v.cursor) && ["backfill", "verification"].includes(v.phase)) &&
    [v.pages, v.repaired, v.verified].every(n => Number.isSafeInteger(n) && n >= 0));
}

function decode(item: Item): Record<string, unknown> {
  try { const value: unknown = JSON.parse(item.data?.S ?? "null");
    if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
    return value as Record<string, unknown>;
  } catch { return fail(); }
}
function condition(table: string, item: Item): TransactWriteItem {
  if (!validKey({ pk: item.pk?.S, sk: item.sk?.S }) || !item.data?.S || !item.entityType?.S) return fail();
  return identityCondition(table, { pk: item.pk!.S!, sk: item.sk!.S!, item, value: null });
}

// Operator-only: the CLI verifies deployment provenance and writer continuity on
// every page. No request-path scan, permission grant or reader activation exists.
export class HomeLeagueCoverageRunner {
  constructor(private readonly client: IdentityClient, readonly manifest: HomeLeagueManifest,
    private readonly now: () => string = () => new Date().toISOString()) {
    if (!manifestValid(manifest) || manifest.writerVersion !== HOME_LOOKUP_WRITER_VERSION) fail();
  }
  private async get(keyPk: string, keySk: string): Promise<Item | null> {
    return (await this.client.send(new GetItemCommand({ TableName: this.manifest.tableName,
      Key: { pk: { S: keyPk }, sk: { S: keySk } }, ConsistentRead: true })) as GetItemCommandOutput).Item ?? null;
  }
  private async snapshot(): Promise<IdentitySnapshot<HomeLeagueCoverage> | null> {
    const item = await this.get(pk, sk);
    if (!item) return null;
    const v = decode(item) as unknown as HomeLeagueCoverage;
    if (item.entityType?.S !== entityType || !validHomeLeagueCoverage(v, this.manifest.tableName) ||
      v.manifest.tableArn !== this.manifest.tableArn) fail();
    return { pk, sk, item, value: v };
  }
  async status(): Promise<HomeLeagueCoverage | null> { return (await this.snapshot())?.value ?? null; }
  async begin(): Promise<HomeLeagueCoverage> {
    const old = await this.snapshot();
    if (old && old.value.phase !== "disabled") throw new Error("Disable existing coverage before starting a new reconciliation.");
    const value: HomeLeagueCoverage = { version: 1, epoch: randomUUID(), manifest: this.manifest,
      phase: "backfill", cursor: null, pages: 0, repaired: 0, verified: 0 };
    await this.client.send(new TransactWriteItemsCommand({ TransactItems: [identityPut(this.manifest.tableName,
      old ?? { pk, sk, item: null, value }, entityType, value, this.now())] }));
    return value;
  }
  async disable(): Promise<HomeLeagueCoverage | null> {
    const old = await this.snapshot();
    if (!old) return null;
    const value = { ...old.value, phase: "disabled" as const, cursor: null };
    await this.client.send(new TransactWriteItemsCommand({ TransactItems: [identityPut(this.manifest.tableName, old, entityType, value, this.now())] }));
    return value;
  }
  async step(beforeMutation: () => unknown = () => undefined): Promise<HomeLeagueCoverage> {
    const old = await this.snapshot();
    if (!old || JSON.stringify(old.value.manifest) !== JSON.stringify(this.manifest)) fail();
    if (!["backfill", "verification"].includes(old.value.phase)) throw new Error("Coverage has no active reconciliation page.");
    const start = old.value.cursor;
    const page = await this.client.send(new ScanCommand({ TableName: this.manifest.tableName, ConsistentRead: true,
      Limit: 1000,
      FilterExpression: "#type = :acl OR (begins_with(#pk, :league) AND begins_with(#sk, :aclPrefix))",
      ProjectionExpression: "#pk,#sk,#type,#data,createdAt,updatedAt",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk", "#type": "entityType", "#data": "data" },
      ExpressionAttributeValues: { ":acl": { S: "acl" }, ":league": { S: "LEAGUE#" }, ":aclPrefix": { S: "ACL#USER#" } },
      ExclusiveStartKey: start ? { pk: { S: start.pk }, sk: { S: start.sk } } : undefined })) as ScanCommandOutput;
    if ((page.Items?.length ?? 0) > 1000) fail();
    const next = page.LastEvaluatedKey;
    const cursor = next && Object.keys(next).length ? { pk: next.pk?.S ?? "", sk: next.sk?.S ?? "" } : null;
    if (cursor && (!validKey(cursor) || (start && cursor.pk === start.pk && cursor.sk === start.sk))) fail();
    const sources = (page.Items ?? []).filter(source => source.entityType?.S === "acl" ||
      source.pk?.S?.startsWith("LEAGUE#") && source.sk?.S?.startsWith("ACL#USER#"));
    let count = 0;
    for (let offset = 0; offset < sources.length; offset += 25) {
      const actions: TransactWriteItem[] = [];
      for (const source of sources.slice(offset, offset + 25)) {
        const reservedAcl = source.pk?.S?.startsWith("LEAGUE#") && source.sk?.S?.startsWith("ACL#USER#");
        if (!reservedAcl && source.entityType?.S !== "acl") continue;
        const data = decode(source);
        if (!reservedAcl || source.entityType?.S !== "acl" || !text(data.leagueId) || !text(data.userId) ||
          source.pk?.S !== `LEAGUE#${data.leagueId}` || source.sk?.S !== `ACL#USER#${data.userId}` ||
          !["admin", "scorekeeper", "viewer"].includes(String(data.role)) || !text(data.grantedByUserId) ||
          !text(source.createdAt?.S) || !text(source.updatedAt?.S)) fail();
        actions.push(condition(this.manifest.tableName, source));
        const league = await this.get(source.pk!.S!, "METADATA");
        if (!league) {
          actions.push(identityCondition(this.manifest.tableName, { pk: source.pk!.S!, sk: "METADATA", item: null, value: null }));
          continue; // Orphan ACLs never grant discovery of a deleted league.
        }
        if (league.entityType?.S !== "league" || decode(league).leagueId !== data.leagueId) fail();
        actions.push(condition(this.manifest.tableName, league));
        if (old.value.phase === "backfill") {
          actions.push(homeLeagueLookupPut(this.manifest.tableName, { ...data,
            createdAt: source.createdAt!.S!, updatedAt: source.updatedAt!.S! } as unknown as LeagueAclRecord));
        } else {
          const pointer = await this.get(homeAccountPk(data.userId), homeLeagueSk(data.leagueId));
          if (!pointer || pointer.entityType?.S !== "homeLeagueLookup" || decode(pointer).leagueId !== data.leagueId || decode(pointer).version !== 1) fail();
          actions.push(condition(this.manifest.tableName, pointer));
        }
        count += 1;
      }
      // Partial page writes are replayable; never advance its physical checkpoint.
      actions.push(identityCondition(this.manifest.tableName, old));
      await beforeMutation();
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction(actions) }));
    }
    const value: HomeLeagueCoverage = { ...old.value, cursor, pages: old.value.pages + 1,
      repaired: old.value.repaired + (old.value.phase === "backfill" ? count : 0),
      verified: old.value.verified + (old.value.phase === "verification" ? count : 0),
      phase: cursor ? old.value.phase : old.value.phase === "backfill" ? "verification" : "ready" };
    // All chunks must succeed before checkpoint/readiness, under the same epoch.
    await beforeMutation();
    await this.client.send(new TransactWriteItemsCommand({ TransactItems: [
      identityPut(this.manifest.tableName, old, entityType, value, this.now()),
    ] }));
    return value;
  }
}
