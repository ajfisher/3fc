import { GetItemCommand, QueryCommand, ScanCommand, TransactWriteItemsCommand,
  type AttributeValue, type GetItemCommandOutput, type QueryCommandOutput, type ScanCommandOutput, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { randomUUID } from "node:crypto";
import { PROOF_ID_PATTERN } from "../auth/player-proof.js";
import { PlayerIdentityError, PlayerIdentityPlanner, boundedIdentityTransaction, identityCondition, identityPut,
  type IdentityClient, type IdentitySnapshot } from "./player-identity.js";

type Item = Record<string, AttributeValue>;
interface Receipt {
  leagueId: string;
  deletionId: string;
  ownerId: string | null;
  phase: "pointers" | "invites" | "access" | "share" | "complete";
  cursor: { pk: string; sk: string } | null;
  cleanupVersion?: 2;
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
        (value.cleanupVersion !== undefined && value.cleanupVersion !== 2) ||
        !["pointers", "invites", "access", "share", "complete"].includes(value.phase) ||
        (value.cursor !== null && (!validKey(value.cursor) || !["pointers", "invites", "access"].includes(value.phase))) ||
        (value.phase === "access" && value.cursor && (value.cursor.pk !== pk || !value.cursor.sk.startsWith("ACL#USER#")))) throw invalid();
    return { pk, sk, item, value };
  }
  owns(receipt: IdentitySnapshot<Receipt>, userIds?: readonly string[]): boolean {
    return receipt.value.ownerId === null ? userIds === undefined : Boolean(userIds?.includes(receipt.value.ownerId));
  }
  start(leagueId: string, userIds?: readonly string[]): TransactWriteItem {
    if (userIds && !userIds[0]) throw new PlayerIdentityError("league_cleanup_forbidden", 403, "Only the organiser who started removal can retry it.");
    const value: Receipt = { leagueId, deletionId: randomUUID(), ownerId: userIds?.[0] ?? null, phase: "pointers", cursor: null, cleanupVersion: 2 };
    return identityPut(this.tableName, { pk: `LEAGUE#${leagueId}`, sk: "DELETION", item: null, value }, "leagueDeletion", value, this.now());
  }
  async resume(leagueId: string, userIds?: readonly string[]): Promise<boolean> {
    // At most five bounded pages per HTTP attempt. Large tables retain the
    // checkpoint and return a retryable 503 instead of falsely returning 204.
    for (let pages = 0; pages < 5; pages += 1) {
      const receipt = await this.read(leagueId);
      if (!receipt) return false;
      if (!this.owns(receipt, userIds)) throw new PlayerIdentityError("league_cleanup_forbidden", 403, "Only the organiser who started removal can retry it.");
      if (receipt.value.phase === "complete" && receipt.value.cleanupVersion === 2) return true;
      const control = await this.identities.readControl();
      const fence = this.identities.writableControl(control);
      // Earlier receipts only covered organiser invitations. Revisit their
      // scan once, including already-completed removals, to clear profile-link
      // pointers without invalidating consumed ownership receipts.
      if (receipt.value.cleanupVersion !== 2) {
        await this.client.send(new TransactWriteItemsCommand({ TransactItems: [fence,
          identityCondition(this.tableName, { pk: receipt.pk, sk: "METADATA", item: null, value: null }),
          identityPut(this.tableName, receipt, "leagueDeletion", { ...receipt.value, phase: "pointers", cursor: null, cleanupVersion: 2 }, this.now()),
        ] }));
        continue;
      }
      const start = receipt.value.cursor ? { pk: { S: receipt.value.cursor.pk }, sk: { S: receipt.value.cursor.sk } } : undefined;
      let items: Item[] = [], next: Item | undefined;
      const phase = receipt.value.phase;
      if (phase === "pointers" || phase === "invites") {
        const page = await this.client.send(new ScanCommand({ TableName: this.tableName, ConsistentRead: true, Limit: 25, ExclusiveStartKey: start })) as ScanCommandOutput;
        next = page.LastEvaluatedKey;
        for (const item of page.Items ?? []) {
          const type = item.entityType?.S;
          if ((item.pk?.S?.startsWith("PLAYER#") && item.sk?.S === "CLAIM_INVITATION") || type === "playerProofPointer") {
            if (phase !== "pointers") continue;
            let data: { proofId?: string; leagueId?: string }; try { data = JSON.parse(item.data?.S ?? "null"); } catch { throw invalid(); }
            if (type !== "playerProofPointer" || !item.pk?.S?.startsWith("PLAYER#") || item.sk?.S !== "CLAIM_INVITATION" ||
                !data || typeof data.proofId !== "string" || !PROOF_ID_PATTERN.test(data.proofId)) throw invalid();
            const linked = (await this.client.send(new GetItemCommand({ TableName: this.tableName,
              Key: { pk: { S: `PLAYER_PROOF#${data.proofId}` }, sk: { S: "METADATA" } }, ConsistentRead: true })) as GetItemCommandOutput).Item;
            const proof = linked ? this.invitationRecord(linked) : null;
            if (proof && (proof.playerId !== item.pk.S.slice(7) || proof.proofId !== data.proofId || proof.kind !== "invitation" ||
                (data.leagueId !== undefined && data.leagueId !== proof.leagueId))) throw invalid();
            const scope = data.leagueId ?? proof?.leagueId;
            // A legacy pointer whose proof already expired has no known league
            // and cannot authorize a claim. Leave it untouched: another league's
            // organiser can already inspect its expired proofId and explicitly
            // replace it. Never infer scope or mutate unrelated orphan records.
            if (scope === undefined && !linked) continue;
            if (typeof scope !== "string" || !scope) throw invalid();
            if (scope === leagueId) items.push(item);
            continue;
          }
          // Finish the complete pointer pass before deleting any proof: older
          // pointers derive their league from that proof, and Scan has no order.
          if (phase === "pointers") continue;
          if (item.pk?.S?.startsWith("PLAYER_PROOF#") || type === "playerProof") {
            const proof = this.invitationRecord(item);
            // Consumed proofs are ownership/replay receipts, not outstanding
            // invitations. Preserve their exact result and account binding.
            if (proof.leagueId === leagueId && proof.kind === "invitation" && proof.state !== "consumed") items.push(item);
            continue;
          }
          const reserved = item.pk?.S?.startsWith("LEAGUE_INVITE#");
          if (!reserved && item.entityType?.S !== "leagueInvite") continue;
          let data: { leagueId?: string; inviteCode?: string }; try { data = JSON.parse(item.data?.S ?? "null"); } catch { throw invalid(); }
          if (item.entityType?.S !== "leagueInvite" || !data || typeof data.leagueId !== "string" || !data.leagueId ||
              typeof data.inviteCode !== "string" || !data.inviteCode ||
              item.pk?.S !== `LEAGUE_INVITE#${data.inviteCode}` || item.sk?.S !== "METADATA") throw invalid();
          if (data.leagueId === leagueId) items.push(item);
        }
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
      const nextPhase = cursor ? phase : phase === "pointers" ? "invites" : phase === "invites" ? "access" : phase === "access" ? "share" : "complete";
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

  private invitationRecord(item: Item): { proofId: string; playerId: string; leagueId: string; kind: string; state: string } {
    let data: { proofId: string; playerId: string; leagueId: string; kind: string; state: string };
    try { data = JSON.parse(item.data?.S ?? "null"); } catch { throw invalid(); }
    if (item.entityType?.S !== "playerProof" || !data || typeof data.proofId !== "string" || !PROOF_ID_PATTERN.test(data.proofId) ||
        item.pk?.S !== `PLAYER_PROOF#${data.proofId}` || item.sk?.S !== "METADATA" ||
        typeof data.playerId !== "string" || !data.playerId || typeof data.leagueId !== "string" || !data.leagueId ||
        !["invitation", "registration"].includes(data.kind) || !["pending", "revoked", "consumed"].includes(data.state)) throw invalid();
    return data;
  }
}
