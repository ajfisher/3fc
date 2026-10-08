import { createHash } from "node:crypto";
import type { TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { identityItem } from "./player-identity.js";
import type { LeagueAclRecord } from "./types.js";

// Dedicated, bounded namespace. A pointer discovers a candidate league only;
// readers must still check current league metadata, deletion state and ACL.
export function homeAccountPk(userId: string): string {
  return `HOME_ACCOUNT#${createHash("sha256").update(userId).digest("hex")}`;
}
export function homeLeagueSk(leagueId: string): string {
  return `LEAGUE#${createHash("sha256").update(leagueId).digest("hex")}`;
}
export function homeLeagueLookupPut(tableName: string, acl: LeagueAclRecord): TransactWriteItem {
  return { Put: { TableName: tableName, Item: identityItem(homeAccountPk(acl.userId), homeLeagueSk(acl.leagueId),
    "homeLeagueLookup", { leagueId: acl.leagueId, version: 1 }, acl.updatedAt, acl.createdAt) } };
}
export function homeLeagueLookupDelete(tableName: string, userId: string, leagueId: string): TransactWriteItem {
  return { Delete: { TableName: tableName, Key: { pk: { S: homeAccountPk(userId) }, sk: { S: homeLeagueSk(leagueId) } } } };
}
