import type { AuthSessionRecord } from "./auth/magic-link.js";
import { PlayerProofError } from "./auth/player-proof.js";
import { claimPlayerRequestSchema, createPlayerInvitationRequestSchema, playerProofCredentialSchema,
  revokePlayerInvitationRequestSchema } from "./contracts/core-write.js";
import type { ThreeFcRepository } from "./data/repository.js";

export type PlayerProofRepository = Pick<ThreeFcRepository,
  "getPlayer" | "claimPlayer" | "previewPlayerProof" | "createPlayerInvitation" | "getPlayerInvitation" | "revokePlayerInvitation">;

export function isPlayerProofRoute(method: string, route: string): boolean {
  return (method === "POST" && (route === "/v1/player-proofs/preview" || /^\/v1\/players\/[^/]+\/claim$/.test(route))) ||
    ((method === "GET" || method === "POST") && /^\/v1\/games\/[^/]+\/players\/[^/]+\/profile-invitation$/.test(route)) ||
    (method === "POST" && /^\/v1\/games\/[^/]+\/players\/[^/]+\/profile-invitation\/revoke$/.test(route));
}

export async function handlePlayerProofRoute(input: {
  method: string; route: string; body: unknown; session: AuthSessionRecord | null; repository: PlayerProofRepository;
}): Promise<{ statusCode: number; payload: Record<string, unknown> }> {
  const { method, route, body, session, repository } = input;
  if (!session) return { statusCode: 401, payload: { error: "unauthorized", message: "Sign in to continue." } };
  const userId = session.subject ?? session.email;
  const userIds = [...new Set([userId, session.email])];
  const invalid = () => ({ statusCode: 400, payload: { error: "bad_request", message: "Invalid profile-link request. Check the link and try again." } });
  try {
    if (method === "POST" && route === "/v1/player-proofs/preview") {
      const parsed = playerProofCredentialSchema.safeParse(body);
      if (!parsed.success) return invalid();
      return { statusCode: 200, payload: {
        preview: await repository.previewPlayerProof({ ...parsed.data, userId, sessionId: session.sessionId }),
        // Display and binding must originate from the same resolved session.
        // A separate session probe can race an account switch in another tab.
        account: { email: session.email },
      } };
    }
    const claim = /^\/v1\/players\/([^/]+)\/claim$/.exec(route);
    if (method === "POST" && claim) {
      const parsed = claimPlayerRequestSchema.safeParse(body);
      if (!parsed.success) return invalid();
      const playerId = decodeURIComponent(claim[1]);
      if (!parsed.data.proof) {
        const existing = await repository.getPlayer(playerId, { consistentRead: true });
        if (existing?.claimedByUserId !== userId) {
          throw new PlayerProofError("claim_proof_required", 403, "Use a private profile link to link this player. Ask the organiser for help.");
        }
      }
      // No generic idempotency cache wraps acceptance. Its receipt is checked
      // only after the repository verifies the current session binding.
      const player = await repository.claimPlayer({ playerId, userId, sessionId: session.sessionId, proof: parsed.data.proof });
      if (!player) return { statusCode: 404, payload: { error: "not_found", message: "This player is no longer available." } };
      return { statusCode: 200, payload: {
        player: { playerId: player.playerId, nickname: player.nickname, createdAt: player.createdAt, updatedAt: player.updatedAt },
        claim: { claimedByCurrentUser: true },
      } };
    }
    const invitation = /^\/v1\/games\/([^/]+)\/players\/([^/]+)\/profile-invitation(\/revoke)?$/.exec(route);
    if (invitation) {
      const context = { gameId: decodeURIComponent(invitation[1]), playerId: decodeURIComponent(invitation[2]), userIds };
      if (method === "GET" && !invitation[3]) return { statusCode: 200, payload: { invitation: await repository.getPlayerInvitation(context) } };
      if (method === "POST" && invitation[3]) {
        const parsed = revokePlayerInvitationRequestSchema.safeParse(body);
        if (!parsed.success) return invalid();
        await repository.revokePlayerInvitation({ ...context, ...parsed.data });
        return { statusCode: 200, payload: { revoked: true } };
      }
      if (method === "POST") {
        const parsed = createPlayerInvitationRequestSchema.safeParse(body);
        if (!parsed.success) return invalid();
        return { statusCode: 201, payload: { invitation: await repository.createPlayerInvitation({ ...context, ...parsed.data }) } };
      }
    }
    return { statusCode: 404, payload: { error: "not_found", message: "Not found." } };
  } catch (error) {
    if (error instanceof URIError) return invalid();
    if (error instanceof PlayerProofError) return { statusCode: error.statusCode, payload: {
      error: error.statusCode === 403 ? "forbidden" : error.statusCode === 404 ? "not_found" : error.statusCode === 503 ? "unavailable" : "conflict",
      code: error.code, message: error.message,
    } };
    throw error;
  }
}
