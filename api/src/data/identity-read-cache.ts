import { BatchGetItemCommand, GetItemCommand, type AttributeValue, type BatchGetItemCommandOutput } from "@aws-sdk/client-dynamodb";
import { PlayerIdentityError, type IdentityClient } from "./player-identity.js";

type Item = Record<string, AttributeValue>;
export type IdentityReadKey = { pk: string; sk: string };
const unavailable = (): never => { throw new PlayerIdentityError("owned_players_unavailable", 503, "Your linked players could not be checked. Try again."); };
const physical = ({ pk, sk }: IdentityReadKey): string => {
  if (typeof pk !== "string" || typeof sk !== "string" || !pk || !sk || Buffer.byteLength(pk) > 2048 || Buffer.byteLength(sk) > 1024) return unavailable();
  return JSON.stringify([pk, sk]);
};
function itemKey(item: Item): string {
  if (!item || typeof item !== "object" || Array.isArray(item)) return unavailable();
  return physical({ pk: item.pk?.S as string, sk: item.sk?.S as string });
}

/** One discovery request only. No writes and no cache across requests. */
export class IdentityReadCache implements IdentityClient {
  private readonly items = new Map<string, Item | undefined>();
  constructor(private readonly client: IdentityClient, private readonly tableName: string) {}
  async send(command: unknown): Promise<unknown> {
    if (!(command instanceof GetItemCommand) || command.input.TableName !== this.tableName || command.input.ConsistentRead !== true || !command.input.Key) return unavailable();
    const key = itemKey(command.input.Key);
    // Every lookup is explicitly prefetched: an omitted phase must fail rather
    // than silently restoring hundreds of serial network reads.
    if (!this.items.has(key)) return unavailable();
    return { Item: structuredClone(this.items.get(key)) };
  }
  async prefetch(keys: readonly IdentityReadKey[]): Promise<void> {
    if (keys.length > 2500) return unavailable();
    const unique = new Map<string, Item>();
    for (const key of keys) {
      const id = physical(key);
      if (!this.items.has(id)) unique.set(id, { pk: { S: key.pk }, sk: { S: key.sk } });
    }
    const entries = [...unique.values()];
    for (let start = 0; start < entries.length; start += 400) {
      const tasks: Promise<void>[] = [];
      for (let offset = start; offset < Math.min(start + 400, entries.length); offset += 100) tasks.push(this.batch(entries.slice(offset, offset + 100)));
      const settled = await Promise.allSettled(tasks);
      for (const result of settled) if (result.status === "rejected") throw result.reason;
    }
  }
  private async batch(initial: Item[]): Promise<void> {
    let pending = initial;
    for (let attempt = 0; attempt < 3; attempt++) {
      const requested = new Set(pending.map(itemKey));
      const output = await this.client.send(new BatchGetItemCommand({ RequestItems: {
        [this.tableName]: { Keys: pending, ConsistentRead: true },
      } })) as BatchGetItemCommandOutput;
      const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
      if (!object(output) || (Object.hasOwn(output, "Responses") && !object(output.Responses)) ||
          (Object.hasOwn(output, "UnprocessedKeys") && !object(output.UnprocessedKeys)) ||
          Object.keys(output.Responses ?? {}).some(table => table !== this.tableName) ||
          Object.keys(output.UnprocessedKeys ?? {}).some(table => table !== this.tableName)) return unavailable();
      const rows = Object.hasOwn(output.Responses ?? {}, this.tableName) ? output.Responses![this.tableName] : [];
      const remaining = Object.hasOwn(output.UnprocessedKeys ?? {}, this.tableName) ? output.UnprocessedKeys![this.tableName] : undefined;
      if (Object.hasOwn(output.UnprocessedKeys ?? {}, this.tableName) && (!object(remaining) || !Array.isArray(remaining.Keys))) return unavailable();
      const retry = remaining === undefined ? [] : remaining.Keys;
      if (!Array.isArray(rows) || !Array.isArray(retry)) return unavailable();
      const returned = new Map<string, Item>(), unprocessed = new Map<string, Item>();
      for (const row of rows) {
        const key = itemKey(row);
        if (!requested.has(key) || returned.has(key)) return unavailable();
        returned.set(key, row);
      }
      for (const row of retry) {
        const key = itemKey(row);
        if (!requested.has(key) || returned.has(key) || unprocessed.has(key) || Object.keys(row).some(field => !["pk", "sk"].includes(field))) return unavailable();
        unprocessed.set(key, row);
      }
      // Missing is cached only when DynamoDB processed that key. Unprocessed
      // keys remain unknown and are retried within this fixed attempt budget.
      for (const key of requested) if (!unprocessed.has(key)) this.items.set(key, structuredClone(returned.get(key)));
      if (!unprocessed.size) return;
      pending = [...unprocessed.values()];
    }
    return unavailable();
  }
}
