import { createHash } from "node:crypto";
import { z } from "zod";
import { GetItemCommand, QueryCommand, TransactGetItemsCommand, TransactWriteItemsCommand,
  type AttributeValue, type GetItemCommandOutput, type QueryCommandOutput, type TransactGetItemsCommandOutput } from "@aws-sdk/client-dynamodb";
import { HOME_LOOKUP_WRITER_VERSION, homeAccountPk, homeLeagueSk } from "./home-league-lookup.js";
import { HomeLeagueCoverageRunner, validHomeLeagueCoverage, type HomeLeagueManifest } from "./home-league-coverage.js";
import { PlayerIdentityError, identityCondition, identityPut, type IdentityClient } from "./player-identity.js";

type Item = Record<string, AttributeValue>;
const key = (pk: string, sk: string) => ({ pk: { S: pk }, sk: { S: sk } });
function unavailable(): never { throw new PlayerIdentityError("home_lookup_unavailable", 503, "League navigation is temporarily unavailable. Try again."); }
function invalid(): never { throw new PlayerIdentityError("home_cursor_invalid", 400, "Refresh the league list and try again."); }
const body = (item: Item, type: string): Record<string, unknown> => {
  try { const data = JSON.parse(item.data?.S ?? "null");
    if (item.entityType?.S !== type || !data || typeof data !== "object" || Array.isArray(data)) return unavailable();
    return data;
  } catch { return unavailable(); }
};
export const homeLeagueReaderSchema = z.object({ version: z.literal(1), enabled: z.boolean(), coverageEpoch: z.string().min(1).nullable() }).strict();
const cursorSchema = z.object({ version: z.literal(1), binding: z.string(), management: z.boolean(),
  accounts: z.array(z.object({ after: z.string().regex(/^LEAGUE#[a-f0-9]{64}$/).nullable(), done: z.boolean() }).strict()).min(1).max(2) }).strict();
export const homeLeaguePageSchema = z.object({ leagues: z.array(z.object({ leagueId: z.string().min(1), name: z.string().min(1), slug: z.string().nullable() }).strict()).max(20),
  hasManagementAccess: z.boolean().nullable(), cursor: z.string().nullable(), complete: z.boolean() }).strict();
export type HomeLeaguePage = z.infer<typeof homeLeaguePageSchema>;

async function read(client: IdentityClient, table: string, pk: string, sk: string): Promise<Item | null> {
  return (await client.send(new GetItemCommand({ TableName: table, Key: key(pk, sk), ConsistentRead: true })) as GetItemCommandOutput).Item ?? null;
}
/** Separate reader activation: ready coverage alone never enables navigation.
 * Operator CLI verifies the current compatible deployment before calling this. */
export async function setHomeLeagueReader(client: IdentityClient, manifest: HomeLeagueManifest, enabled: boolean): Promise<void> {
  const runner = new HomeLeagueCoverageRunner(client, manifest);
  const coverage = enabled ? await runner.status() : null;
  const source = enabled ? await read(client, manifest.tableName, "HOME_LOOKUP", "CONTROL") : null;
  const current = source ? body(source, "homeLeagueCoverage") : null;
  if (enabled && (!coverage || coverage.phase !== "ready" || coverage.manifest.tableArn !== manifest.tableArn || coverage.manifest.writerVersion !== manifest.writerVersion ||
    !validHomeLeagueCoverage(current, manifest.tableName) || current.epoch !== coverage.epoch || current.phase !== "ready" ||
    current.manifest.tableArn !== manifest.tableArn || current.manifest.writerVersion !== manifest.writerVersion)) unavailable();
  const old = await read(client, manifest.tableName, "HOME_LOOKUP", "READER");
  if (old && !homeLeagueReaderSchema.safeParse(body(old, "homeLeagueReader")).success) unavailable();
  const value = { version: 1, enabled, coverageEpoch: enabled ? coverage!.epoch : null };
  await client.send(new TransactWriteItemsCommand({ TransactItems: [
    ...(enabled ? [identityCondition(manifest.tableName, { pk: "HOME_LOOKUP", sk: "CONTROL", item: source, value: null })] : []),
    identityPut(manifest.tableName, { pk: "HOME_LOOKUP", sk: "READER", item: old, value: null }, "homeLeagueReader", value, new Date().toISOString()),
  ] }));
}

export class HomeLeagueRead {
  constructor(private readonly client: IdentityClient, private readonly table: string, private readonly writerSha = process.env.API_WRITER_SHA) {}
  async list(input: { userIds: readonly string[]; cursor?: string }): Promise<HomeLeaguePage | null> {
    const accounts = [...new Set(input.userIds)];
    if (!accounts.length || accounts.length > 2 || accounts.some(id => !id.trim() || Buffer.byteLength(id) > 2048)) unavailable();
    const readerItem = await read(this.client, this.table, "HOME_LOOKUP", "READER");
    if (!readerItem) return null; // Explicit rollback/preparation uses the retained reader.
    const readerResult = homeLeagueReaderSchema.safeParse(body(readerItem, "homeLeagueReader"));
    if (!readerResult.success) unavailable();
    const reader = readerResult.data;
    if (!reader.enabled) return null;
    if (!reader.coverageEpoch || !this.writerSha || !/^[a-f0-9]{40}$/.test(this.writerSha)) unavailable();
    const binding = createHash("sha256").update(JSON.stringify([accounts, reader.coverageEpoch])).digest("hex");
    let state: z.infer<typeof cursorSchema> = { version: 1, binding, management: false, accounts: accounts.map(() => ({ after: null, done: false })) };
    if (input.cursor !== undefined) {
      try {
        if (!input.cursor || input.cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) return invalid();
        state = cursorSchema.parse(JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")));
        if (state.binding !== binding || state.accounts.length !== accounts.length || state.accounts.every(row => row.done)) return invalid();
      } catch { return invalid(); }
    }
    const leagueIds = new Set<string>();
    for (let i = 0; i < accounts.length; i++) {
      const progress = state.accounts[i]; if (progress.done) continue;
      const pk = homeAccountPk(accounts[i]);
      const page = await this.client.send(new QueryCommand({ TableName: this.table, ConsistentRead: true, Limit: 10,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :skPrefix)",
        ExpressionAttributeValues: { ":pk": { S: pk }, ":skPrefix": { S: "LEAGUE#" } },
        ...(progress.after ? { ExclusiveStartKey: key(pk, progress.after) } : {}) })) as QueryCommandOutput;
      if ((page.Items?.length ?? 0) > 10) unavailable();
      for (const item of page.Items ?? []) {
        const value = body(item, "homeLeagueLookup");
        if (typeof value.leagueId !== "string" || !value.leagueId || value.version !== 1 || item.pk?.S !== pk ||
          item.sk?.S !== homeLeagueSk(value.leagueId) || progress.after && item.sk.S <= progress.after) unavailable();
        leagueIds.add(value.leagueId);
      }
      const next = page.LastEvaluatedKey;
      if (next && Object.keys(next).length) {
        if (next.pk?.S !== pk || !/^LEAGUE#[a-f0-9]{64}$/.test(next.sk?.S ?? "") || progress.after && next.sk!.S! <= progress.after) unavailable();
        progress.after = next.sk!.S!;
      } else progress.done = true;
    }
    // One atomic snapshot validates authority, deletion and coverage for every
    // candidate. The two account queries discover candidates, never grant access.
    const keys = [key("HOME_LOOKUP", "CONTROL"), key("HOME_LOOKUP", "READER")];
    for (const id of leagueIds) keys.push(key(`LEAGUE#${id}`, "METADATA"), key(`LEAGUE#${id}`, "DELETION"),
      ...accounts.map(account => key(`LEAGUE#${id}`, `ACL#USER#${account}`)));
    if (keys.length > 82) unavailable();
    const snapshot = await this.client.send(new TransactGetItemsCommand({ TransactItems: keys.map(Key => ({ Get: { TableName: this.table, Key } })) })) as TransactGetItemsCommandOutput;
    if (snapshot.Responses?.length !== keys.length) unavailable();
    const items = snapshot.Responses.map(row => row.Item);
    const coverage = items[0] ? body(items[0], "homeLeagueCoverage") : null;
    if (!validHomeLeagueCoverage(coverage, this.table) || coverage.phase !== "ready" || coverage.epoch !== reader.coverageEpoch || coverage.manifest.writerVersion !== HOME_LOOKUP_WRITER_VERSION ||
      !items[1] || JSON.stringify(body(items[1], "homeLeagueReader")) !== JSON.stringify(reader)) unavailable();
    const leagues: HomeLeaguePage["leagues"] = [];
    let offset = 2;
    for (const id of leagueIds) {
      const metadata = items[offset++], deletion = items[offset++];
      const acls = items.slice(offset, offset + accounts.length); offset += accounts.length;
      if (!metadata || deletion) continue;
      const league = body(metadata, "league");
      if (league.leagueId !== id || typeof league.name !== "string" || !league.name || (league.slug !== null && typeof league.slug !== "string")) unavailable();
      let permitted = false;
      for (let i = 0; i < acls.length; i++) {
        if (!acls[i]) continue;
        const acl = body(acls[i]!, "acl");
        if (acl.leagueId !== id || acl.userId !== accounts[i] || !["admin", "scorekeeper", "viewer"].includes(String(acl.role))) unavailable();
        permitted = true; state.management ||= acl.role === "admin" || acl.role === "scorekeeper";
      }
      if (permitted) leagues.push({ leagueId: id, name: league.name, slug: league.slug as string | null });
    }
    const complete = state.accounts.every(row => row.done);
    const value = homeLeaguePageSchema.parse({ leagues: leagues.sort((a, b) => a.name.localeCompare(b.name)),
      hasManagementAccess: state.management ? true : complete ? false : null,
      complete, cursor: complete ? null : Buffer.from(JSON.stringify(state)).toString("base64url") });
    if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) unavailable();
    return value;
  }
}
