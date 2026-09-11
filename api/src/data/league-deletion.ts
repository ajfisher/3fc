import { GetItemCommand, QueryCommand, ScanCommand, TransactWriteItemsCommand,
  type AttributeValue, type GetItemCommandOutput, type QueryCommandOutput, type ScanCommandOutput, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { randomUUID } from "node:crypto";
import { PlayerIdentityError, PlayerIdentityPlanner, boundedIdentityTransaction, identityCondition, identityPut,
  type IdentityClient, type IdentitySnapshot } from "./player-identity.js";

type Item = Record<string, AttributeValue>;
interface Receipt {
  leagueId: string;
  deletionId: string;
  ownerId: string | null;
  phase: "invites" | "access" | "share" | "complete";
  cursor: { pk: string; sk: string } | null;
}
const pending = () => new PlayerIdentityError("league_cleanup_pending", 503,
  "League removal is still finishing. Retry Delete league to complete it.");
const invalid = () => new PlayerIdentityError("league_cleanup_unavailable", 503, "League removal needs organiser support.");
const validKey = (value: unknown): value is { pk: string; sk: string } => {
  const v = value as { pk?: unknown; sk?: unknown } | null;
  return Boolean(v && typeof v.pk === "string" && v.pk && Buffer.byteLength(v.pk) <= 2048 &&
    typeof v.sk === "string" && v.sk && Buffer.byteLength(v.sk) <= 1024);
};

// A receipt grants only recovery of this exact deletion, never general league
// access. Each page's cleanup and checkpoint commit together; no unbounded
// transaction, single-page completeness assumption or detached worker.
export class LeagueDeletionCleanup {
  private readonly identities: PlayerIdentityPlanner;
  constructor(private readonly client: IdentityClient, private readonly tableName: string, private readonly now: () => string) {
    this.identities = new PlayerIdentityPlanner(client, tableName);
  }
  async read(leagueId: string): Promise<IdentitySnapshot<Receipt> | null> {
    const pk = `LEAGUE#${leagueId}`, sk = "DELETION";
    const item = (await this.client.send(new GetItemCommand({ TableName: this.tableName,
      Key: { pk: { S: pk }, sk: { S: sk } }, ConsistentRead: true })) as GetItemCommandOutput).Item;
    if (!item) return null;
    let value: Receipt;
    try { value = JSON.parse(item.data?.S ?? "null"); } catch { throw invalid(); }
    if (item.entityType?.S !== "leagueDeletion" || !value || value.leagueId !== leagueId ||
        typeof value.deletionId !== "string" || !value.deletionId ||
        (value.ownerId !== null && (typeof value.ownerId !== "string" || !value.ownerId)) ||
        !["invites", "access", "share", "complete"].includes(value.phase) ||
        (value.cursor !== null && (!validKey(value.cursor) || !["invites", "access"].includes(value.phase))) ||
        (value.phase === "access" && value.cursor && (value.cursor.pk !== pk || !value.cursor.sk.startsWith("ACL#USER#")))) throw invalid();
    return { pk, sk, item, value };
  }
  owns(receipt: IdentitySnapshot<Receipt>, userIds?: readonly string[]): boolean {
    return receipt.value.ownerId === null ? userIds === undefined : Boolean(userIds?.includes(receipt.value.ownerId));
  }
  start(leagueId: string, userIds?: readonly string[]): TransactWriteItem {
    if (userIds && !userIds[0]) throw new PlayerIdentityError("league_cleanup_forbidden", 403, "Only the organiser who started removal can retry it.");
    const value: Receipt = { leagueId, deletionId: randomUUID(), ownerId: userIds?.[0] ?? null, phase: "invites", cursor: null };
    return identityPut(this.tableName, { pk: `LEAGUE#${leagueId}`, sk: "DELETION", item: null, value }, "leagueDeletion", value, this.now());
  }
  async resume(leagueId: string, userIds?: readonly string[]): Promise<boolean> {
    // At most five bounded pages per HTTP attempt. Large tables retain the
    // checkpoint and return a retryable 503 instead of falsely returning 204.
    for (let pages = 0; pages < 5; pages += 1) {
      const receipt = await this.read(leagueId);
      if (!receipt) return false;
      if (!this.owns(receipt, userIds)) throw new PlayerIdentityError("league_cleanup_forbidden", 403, "Only the organiser who started removal can retry it.");
      if (receipt.value.phase === "complete") return true;
      const control = await this.identities.readControl();
      const fence = this.identities.writableControl(control);
      const start = receipt.value.cursor ? { pk: { S: receipt.value.cursor.pk }, sk: { S: receipt.value.cursor.sk } } : undefined;
      let items: Item[] = [], next: Item | undefined;
      const phase = receipt.value.phase;
      if (phase === "invites") {
        const page = await this.client.send(new ScanCommand({ TableName: this.tableName, ConsistentRead: true, Limit: 25, ExclusiveStartKey: start })) as ScanCommandOutput;
        next = page.LastEvaluatedKey;
        items = (page.Items ?? []).filter(item => {
          const reserved = item.pk?.S?.startsWith("LEAGUE_INVITE#");
          if (!reserved && item.entityType?.S !== "leagueInvite") return false;
          let data: { leagueId?: string; inviteCode?: string }; try { data = JSON.parse(item.data?.S ?? "null"); } catch { throw invalid(); }
          if (item.entityType?.S !== "leagueInvite" || !data || typeof data.leagueId !== "string" || !data.leagueId ||
              typeof data.inviteCode !== "string" || !data.inviteCode ||
              item.pk?.S !== `LEAGUE_INVITE#${data.inviteCode}` || item.sk?.S !== "METADATA") throw invalid();
          return data.leagueId === leagueId;
        });
      } else if (phase === "access") {
        const page = await this.client.send(new QueryCommand({ TableName: this.tableName, ConsistentRead: true, Limit: 25, ExclusiveStartKey: start,
          KeyConditionExpression: "pk = :pk AND begins_with(sk, :skPrefix)",
          ExpressionAttributeValues: { ":pk": { S: receipt.pk }, ":skPrefix": { S: "ACL#USER#" } } })) as QueryCommandOutput;
        next = page.LastEvaluatedKey; items = page.Items ?? [];
        if (items.some(item => item.pk?.S !== receipt.pk || !item.sk?.S?.startsWith("ACL#USER#") || item.entityType?.S !== "acl")) throw invalid();
      } else {
        const item = (await this.client.send(new GetItemCommand({ TableName: this.tableName,
          Key: { pk: { S: receipt.pk }, sk: { S: "INVITE#ORGANISER_SHARE" } }, ConsistentRead: true })) as GetItemCommandOutput).Item;
        if (item) { if (item.entityType?.S !== "leagueInvitePointer") throw invalid(); items = [item]; }
      }
      const cursor = next ? { pk: next.pk?.S ?? "", sk: next.sk?.S ?? "" } : null;
      if (cursor && !validKey(cursor)) throw invalid();
      const nextPhase = cursor ? phase : phase === "invites" ? "access" : phase === "access" ? "share" : "complete";
      const deletes = items.map(item => {
        if (!item.pk?.S || !item.sk?.S || !item.entityType?.S || !item.data?.S) throw invalid();
        const condition = identityCondition(this.tableName, { pk: item.pk.S, sk: item.sk.S, item, value: null }).ConditionCheck!;
        return { Delete: condition } as TransactWriteItem;
      });
      try {
        await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction([
          fence, identityCondition(this.tableName, { pk: receipt.pk, sk: "METADATA", item: null, value: null }),
          ...deletes, identityPut(this.tableName, receipt, "leagueDeletion", { ...receipt.value, phase: nextPhase, cursor }, this.now()),
        ]) }));
      } catch (error) {
        // Another resume or changed snapshot cannot silently count as cleanup.
        if (["TransactionCanceledException", "ConditionalCheckFailedException"].includes((error as Error)?.name)) throw pending();
        throw error;
      }
      if (nextPhase === "complete") return true;
    }
    throw pending();
  }
}
