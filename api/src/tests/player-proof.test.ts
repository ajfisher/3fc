import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  createPlayerConfirmation, hashPlayerProofSecret, parsePlayerClaimMode,
  PlayerProofError, requirePlayerClaimEnabled, verifyPlayerConfirmation,
} from "../auth/player-proof.js";

const now = Date.parse("2026-09-10T00:00:00Z");
const context = { sessionId: "private-session-A", userId: "account-A", proofId: "proof-A", revision: "revision-A" };

test("claim mode defaults to proof and rejects unknown configuration", () => {
  assert.equal(parsePlayerClaimMode(undefined), "proof");
  assert.equal(parsePlayerClaimMode("proof"), "proof");
  assert.equal(parsePlayerClaimMode("disabled"), "disabled");
  for (const value of ["", "legacy", "PROOF", "false"]) assert.throws(() => parsePlayerClaimMode(value));
  assert.doesNotThrow(() => requirePlayerClaimEnabled("proof"));
  assert.throws(() => requirePlayerClaimEnabled("disabled"), (error: unknown) =>
    error instanceof PlayerProofError && error.statusCode === 503);
});

test("claim secrets require canonical 256-bit encoding and produce only a verifier", () => {
  const secret = randomBytes(32).toString("base64url");
  assert.match(hashPlayerProofSecret(secret), /^[a-f0-9]{64}$/);
  assert.equal(hashPlayerProofSecret(secret), hashPlayerProofSecret(secret));
  for (const invalid of ["", "x".repeat(43), "a".repeat(42), "a".repeat(44), secret + "="]) {
    assert.throws(() => hashPlayerProofSecret(invalid), PlayerProofError);
  }
});

test("confirmation is opaque and bound to the exact resolved account, session, proof and revision", () => {
  const binding = createPlayerConfirmation(context, now);
  assert.doesNotThrow(() => verifyPlayerConfirmation(context, binding, now));
  assert.ok(!binding.includes(context.sessionId));
  assert.ok(!binding.includes(context.userId));
  for (const change of [{ sessionId: "private-session-B" }, { userId: "account-B" }, { proofId: "proof-B" }, { revision: "revision-B" }]) {
    assert.throws(() => verifyPlayerConfirmation({ ...context, ...change }, binding, now), PlayerProofError);
  }
  assert.throws(() => verifyPlayerConfirmation(context, binding + "x", now), PlayerProofError);
});

test("confirmation expires exactly at its deadline and cannot be extended by editing its timestamp", () => {
  const binding = createPlayerConfirmation(context, now);
  assert.doesNotThrow(() => verifyPlayerConfirmation(context, binding, now + 299_999));
  assert.throws(() => verifyPlayerConfirmation(context, binding, now + 300_000), PlayerProofError);
  const [timestamp, mac] = binding.split(".");
  assert.throws(() => verifyPlayerConfirmation(context, `${Number(timestamp) + 1}.${mac}`, now), PlayerProofError);
});
