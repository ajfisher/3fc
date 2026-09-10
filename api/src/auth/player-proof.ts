import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const PLAYER_PROOF_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CONFIRMATION_TTL_MS = 5 * 60 * 1000;
export const PROOF_ID_PATTERN = /^[a-zA-Z0-9_-]{20,64}$/;
export const PROOF_SECRET_PATTERN = /^[a-zA-Z0-9_-]{43}$/;
export const PROOF_VERIFIER_PATTERN = /^[a-f0-9]{64}$/;

export type PlayerClaimMode = "proof" | "disabled";

export class PlayerProofError extends Error {
  constructor(readonly code: string, readonly statusCode: number, message: string) {
    super(message);
    this.name = "PlayerProofError";
  }
}

export function parsePlayerClaimMode(value: string | undefined): PlayerClaimMode {
  if (value === undefined || value === "proof") return "proof";
  if (value === "disabled") return "disabled";
  throw new Error("PLAYER_CLAIM_MODE must be proof or disabled.");
}

export function requirePlayerClaimEnabled(mode: PlayerClaimMode): void {
  if (mode !== "proof") {
    throw new PlayerProofError("claims_unavailable", 503, "Profile linking is temporarily unavailable. Please try again later.");
  }
}

export function hashPlayerProofSecret(secret: string): string {
  // Require the canonical encoding of exactly 32 random bytes, not arbitrary
  // 43-character strings with non-zero trailing base64 bits.
  if (!PROOF_SECRET_PATTERN.test(secret) || Buffer.from(secret, "base64url").toString("base64url") !== secret) {
    throw new PlayerProofError("invalid_claim_proof", 400, "This profile link is invalid or no longer available.");
  }
  return createHash("sha256").update(secret).digest("hex");
}

export function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface PlayerConfirmationContext {
  sessionId: string;
  userId: string;
  proofId: string;
  revision: string;
}

function confirmationMac(context: PlayerConfirmationContext, expiresAt: number): string {
  return createHmac("sha256", context.sessionId)
    .update(JSON.stringify(["3fc-player-confirmation-v1", context.userId, context.proofId, context.revision, expiresAt]))
    .digest("base64url");
}

export function createPlayerConfirmation(context: PlayerConfirmationContext, now: number): string {
  if (!context.sessionId || !context.userId || !Number.isFinite(now)) throw new Error("Invalid confirmation context.");
  const expiresAt = now + CONFIRMATION_TTL_MS;
  return `${expiresAt}.${confirmationMac(context, expiresAt)}`;
}

export function verifyPlayerConfirmation(context: PlayerConfirmationContext, binding: string, now: number): void {
  const match = /^(\d{13})\.([a-zA-Z0-9_-]{43})$/.exec(binding);
  const expiresAt = match ? Number(match[1]) : 0;
  if (!context.sessionId || !context.userId || !Number.isFinite(now) || !match || expiresAt <= now ||
      expiresAt > now + CONFIRMATION_TTL_MS || !secureEqual(match[2], confirmationMac(context, expiresAt))) {
    throw new PlayerProofError("claim_confirmation_changed", 409, "Please check your signed-in account and confirm again.");
  }
}
