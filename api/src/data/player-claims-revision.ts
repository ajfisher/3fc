import { GetItemCommand, type GetItemCommandOutput, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { randomUUID } from "node:crypto";
import { identityPut, PlayerIdentityError, type IdentityClient, type IdentitySnapshot } from "./player-identity.js";

export interface PlayerClaimsRevision { revision: string }
export async function readPlayerClaimsRevision(client: IdentityClient, tableName: string, userId: string): Promise<IdentitySnapshot<PlayerClaimsRevision>> {
  const pk = `USER#${userId}`, sk = "PLAYER_CLAIMS_REVISION";
  try { encodeURIComponent(userId); } catch { throw new PlayerIdentityError("invalid_account", 400, "Sign in again."); }
  if (!userId.trim() || Buffer.byteLength(pk) > 2048) throw new PlayerIdentityError("invalid_account", 400, "Sign in again.");
  const item = ((await client.send(new GetItemCommand({ TableName: tableName, Key: { pk: { S: pk }, sk: { S: sk } }, ConsistentRead: true }))) as GetItemCommandOutput).Item;
  if (!item) return { pk, sk, item: null, value: { revision: "legacy" } };
  let value: PlayerClaimsRevision;
  try { value = JSON.parse(item.data?.S ?? "null"); } catch { value = null as unknown as PlayerClaimsRevision; }
  if (item.pk?.S !== pk || item.sk?.S !== sk || item.entityType?.S !== "playerClaimsRevision" || !value ||
    typeof value.revision !== "string" || !value.revision.trim()) throw new PlayerIdentityError("player_claims_unavailable", 503, "Your linked players could not be checked. Try again later.");
  return { pk, sk, item, value };
}
export function advancePlayerClaimsRevision(tableName: string, snapshot: IdentitySnapshot<PlayerClaimsRevision>, now: string): TransactWriteItem {
  return identityPut(tableName, snapshot, "playerClaimsRevision", { revision: randomUUID() }, now);
}
