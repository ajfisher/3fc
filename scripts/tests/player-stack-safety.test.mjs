import assert from "node:assert/strict";
import test from "node:test";
import { awaitLoopbackReadiness, cleanupAll } from "../local/player-stack-safety.mjs";

const worker = () => ({ child: { exitCode: null, signalCode: null }, host: null });
const url = "http://127.0.0.1:3001/v1/health";

test("readiness waits when HTTP succeeds before listener metadata arrives", async () => {
  const owned = worker(); let probes = 0; const waits = [];
  await awaitLoopbackReadiness(url, owned, {
    health: async () => { probes++; return true; },
    wait: async milliseconds => { waits.push(milliseconds); if (waits.length === 2) owned.host = { address: "127.0.0.1" }; },
  });
  assert.equal(probes, 3); assert.deepEqual(waits, [100, 100]);
});

test("readiness retries failed health but never accepts wrong listener metadata", async () => {
  const owned = worker(); owned.host = { address: "127.0.0.1" }; let probes = 0;
  await awaitLoopbackReadiness(url, owned, { health: async () => { if (++probes === 1) throw new Error("private response"); return true; }, wait: async () => {} });
  assert.equal(probes, 2);
  owned.host = { address: "0.0.0.0" }; probes = 0;
  await assert.rejects(awaitLoopbackReadiness(url, owned, { health: async () => { probes++; return true; } }), /not loopback/);
  assert.equal(probes, 0);
  await assert.rejects(awaitLoopbackReadiness("https://external.invalid/health", worker(), { health: async () => { probes++; return true; } }), /must be loopback/);
  assert.equal(probes, 0);
});

test("readiness rejects a dead or interrupted worker even after successful health", async () => {
  for (const scenario of ["dead-before", "dead-during", "interrupted"]) {
    const owned = worker(); owned.host = { address: "127.0.0.1" }; let probes = 0;
    if (scenario === "dead-before") owned.child.exitCode = 1;
    await assert.rejects(awaitLoopbackReadiness(url, owned, {
      isInterrupted: () => scenario === "interrupted",
      health: async () => { probes++; owned.child.signalCode = "SIGTERM"; return true; },
    }), /exited before readiness/);
    assert.equal(probes, scenario === "dead-during" ? 1 : 0);
  }
});

test("missing metadata exhausts bounded readiness attempts without real delays", async () => {
  let probes = 0, waits = 0;
  await assert.rejects(awaitLoopbackReadiness(url, worker(), {
    maxAttempts: 3, health: async () => { probes++; return true; }, wait: async () => { waits++; },
  }), /readiness failed/);
  assert.equal(probes, 3); assert.equal(waits, 2);
});

test("Docker cleanup failure cannot skip private cleanup and caller reports failure", async () => {
  const order = [];
  const failed = await cleanupAll([
    { name: "workers", run: async () => { order.push("workers-start"); await Promise.resolve(); order.push("workers-end"); } },
    { name: "docker", run: () => { order.push("docker"); throw new Error("secret-bearing Docker stderr"); } },
    { name: "private-files", run: async () => { order.push("private-start"); await Promise.resolve(); order.push("private-end"); } },
  ]);
  assert.deepEqual(order, ["workers-start", "workers-end", "docker", "private-start", "private-end"]);
  assert.deepEqual(failed, ["docker"]);
  const callerExitCode = failed.length ? 1 : 0;
  assert.equal(callerExitCode, 1);
  assert.equal(JSON.stringify(failed).includes("secret"), false);
});

test("cleanup collects all failures without error payloads and awaits later steps", async () => {
  let completed = false;
  const failed = await cleanupAll([
    { name: "workers", run: async () => { throw { secret: "private worker token" }; } },
    { name: "untrusted token=secret", run: async () => { throw new Error("private path"); } },
    { name: "private-files", run: async () => { completed = true; } },
  ]);
  assert.equal(completed, true); assert.deepEqual(failed, ["workers", "cleanup-step-2"]);
  assert.deepEqual(await cleanupAll([{ name: "clean", run: async () => {} }]), []);
});
