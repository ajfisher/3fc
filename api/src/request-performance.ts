import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import type { DynamoDBClient } from "@aws-sdk/client-dynamodb";

interface RequestPerformance {
  startedAt: number;
  dbCalls: number;
  dbElapsedMs: number;
  dbRetries: number;
  dbFailures: number;
}

const requests = new AsyncLocalStorage<RequestPerformance>();

/** Request-owned counters; concurrent requests and work started outside this scope remain separate. */
export function withRequestPerformance<T>(work: () => Promise<T>): Promise<T> {
  return requests.run({ startedAt: performance.now(), dbCalls: 0, dbElapsedMs: 0, dbRetries: 0, dbFailures: 0 }, work);
}

/** Sum of SDK call elapsed times, including retries. Parallel calls can exceed request duration. */
export function requestPerformance(): Omit<RequestPerformance, "startedAt"> & { durationMs: number } | undefined {
  const current = requests.getStore();
  if (!current) return undefined;
  const rounded = (value: number) => Math.round(value * 100) / 100;
  return { durationMs: rounded(performance.now() - current.startedAt), dbCalls: current.dbCalls,
    dbElapsedMs: rounded(current.dbElapsedMs), dbRetries: current.dbRetries, dbFailures: current.dbFailures };
}

function retries(metadata: unknown): number {
  const attempts = (metadata as { attempts?: unknown } | undefined)?.attempts;
  return typeof attempts === "number" && Number.isSafeInteger(attempts) && attempts > 0 ? attempts - 1 : 0;
}

/** Wrap the complete SDK command, not individual HTTP attempts. Never inspect inputs or errors. */
export function instrumentDynamoDb(client: DynamoDBClient): void {
  client.middlewareStack.add(next => async args => {
    const current = requests.getStore();
    if (!current) return next(args);
    const startedAt = performance.now();
    current.dbCalls += 1;
    try {
      const result = await next(args);
      current.dbRetries += retries(result.output.$metadata);
      return result;
    } catch (error) {
      current.dbFailures += 1;
      current.dbRetries += retries((error as { $metadata?: unknown } | null)?.$metadata);
      throw error;
    } finally {
      current.dbElapsedMs += performance.now() - startedAt;
    }
  }, { name: "threeFcRequestPerformance", step: "initialize", priority: "high" });
}
