import { BatchGetItemCommand, GetItemCommand, type AttributeValue, type BatchGetItemCommandOutput } from "@aws-sdk/client-dynamodb";
import { PlayerIdentityError, type IdentityClient } from "./player-identity.js";

type Item = Record<string, AttributeValue>;
export type IdentityReadKey = { pk: string; sk: string };
type ReadTiming = { now?: () => number; sleep?: (milliseconds: number) => Promise<void>; deadlineMs?: number };
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
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly deadlineMs: number;
  constructor(private readonly client: IdentityClient, private readonly tableName: string, timing: ReadTiming = {}) {
    this.now = timing.now ?? Date.now;
    this.sleep = timing.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    this.deadlineMs = timing.deadlineMs ?? this.now() + 6000;
    if (!Number.isFinite(this.deadlineMs)) unavailable();
  }
  private hasTime(delay = 0): void {
    const now = this.now();
    if (!Number.isFinite(now) || now + delay >= this.deadlineMs) unavailable();
  }
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
    const state = { failed: false };
    for (let start = 0; start < entries.length; start += 400) {
      if (state.failed) return unavailable();
      const tasks: Promise<void>[] = [];
      for (let offset = start; offset < Math.min(start + 400, entries.length); offset += 100) tasks.push(this.batch(entries.slice(offset, offset + 100), state));
      const settled = await Promise.allSettled(tasks);
      for (const result of settled) if (result.status === "rejected") throw result.reason;
    }
  }
  private async batch(initial: Item[], state: { failed: boolean }): Promise<void> {
    try {
    let pending = initial;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (state.failed) return unavailable();
      if (attempt > 0) {
        const delay = 50 * 2 ** (attempt - 1);
        this.hasTime(delay);
        await this.sleep(delay);
      }
      if (state.failed) return unavailable();
      // All waves share one request deadline. This does not cancel an SDK call
      // already in progress, but never starts a retry after its budget expires.
      this.hasTime();
      const requested = new Set(pending.map(itemKey));
      const output = await this.client.send(new BatchGetItemCommand({ RequestItems: {
        [this.tableName]: { Keys: pending, ConsistentRead: true },
      } })) as BatchGetItemCommandOutput;
      if (state.failed) return unavailable();
      this.hasTime();
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
    } catch (error) {
      // Latch in this task before rejecting it. Started SDK calls still settle,
      // but sibling backoff timers cannot launch retries after known failure.
      state.failed = true;
      throw error;
    }
  }
}
