import { setTimeout as delay } from "node:timers/promises";

/** Bounded readiness for an owned local service, including its listener log. */
export async function awaitLoopbackReadiness(url, worker, options = {}) {
  const { isInterrupted = () => false, wait = delay, maxAttempts = 100,
    health = async target => {
      const response = await fetch(target, { signal: AbortSignal.timeout(1000) });
      try { return response.ok; } finally { await response.body?.cancel(); }
    } } = options;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) throw new Error("Invalid readiness budget");
  const target = new URL(url);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || target.username || target.password) throw new Error("Readiness target must be loopback");
  const checkWorker = () => {
    if (isInterrupted() || worker.child.exitCode !== null || worker.child.signalCode !== null) throw new Error("Owned service exited before readiness");
    if (worker.host?.address != null && worker.host.address !== "127.0.0.1") throw new Error("Service listener is not loopback");
  };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    checkWorker();
    let ready = false;
    try { ready = await health(url); } catch { /* bounded transient startup */ }
    checkWorker();
    // HTTP health and stdout listener metadata can arrive in either order.
    if (ready === true && worker.host?.address === "127.0.0.1") return;
    if (attempt + 1 < maxAttempts) await wait(100);
  }
  throw new Error("Owned local service readiness failed");
}

/** Attempt every owned cleanup step, retaining only safe failure labels. */
export async function cleanupAll(steps) {
  const failed = [];
  for (const [index, step] of steps.entries()) {
    const name = typeof step?.name === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(step.name)
      ? step.name : `cleanup-step-${index + 1}`;
    try { await step.run(); } catch { failed.push(name); }
  }
  return failed;
}
