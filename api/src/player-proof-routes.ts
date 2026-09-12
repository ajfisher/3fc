import type { AuthSessionRecord } from "./auth/magic-link.js";
import { PlayerProofError } from "./auth/player-proof.js";
import { PlayerIdentityError } from "./data/player-identity.js";
import { claimPlayerRequestSchema, createPlayerInvitationRequestSchema, playerProofCredentialSchema,
  revokePlayerInvitationRequestSchema } from "./contracts/core-write.js";
import type { ThreeFcRepository } from "./data/repository.js";

export type PlayerProofRepository = Pick<ThreeFcRepository,
  "getPlayer" | "claimPlayer" | "previewPlayerProof" | "createPlayerInvitation" | "getPlayerInvitation" | "revokePlayerInvitation">;

export function isPlayerProofRoute(method: string, route: string): boolean {
  if (((method === "GET" || method === "POST") && route === "/v1/player-proofs/league-invitation") ||
      (method === "POST" && route === "/v1/player-proofs/league-invitation/revoke")) return true;
  return (method === "POST" && ["/v1/player-proofs/claim", "/v1/player-proofs/invitation/revoke"].includes(route)) ||
    ((method === "GET" || method === "POST") && route === "/v1/player-proofs/invitation") ||
    (method === "POST" && (route === "/v1/player-proofs/preview" || /^\/v1\/players\/[^/]+\/claim$/.test(route))) ||
    ((method === "GET" || method === "POST") && /^\/v1\/games\/[^/]+\/players\/[^/]+\/profile-invitation$/.test(route)) ||
    (method === "POST" && /^\/v1\/games\/[^/]+\/players\/[^/]+\/profile-invitation\/revoke$/.test(route));
}

export async function handlePlayerProofRoute(input: {
  method: string; route: string; body: unknown; rawQueryString?: string; session: AuthSessionRecord | null; repository: PlayerProofRepository;
}): Promise<{ statusCode: number; payload: Record<string, unknown> }> {
  const { method, route, body, session, repository } = input;
  if (!session) return { statusCode: 401, payload: { error: "unauthorized", message: "Sign in to continue." } };
  const userId = session.subject ?? session.email;
  const userIds = [...new Set([userId, session.email])];
  const invalid = () => ({ statusCode: 400, payload: { error: "bad_request", message: "Invalid profile-link request. Check the link and try again." } });
  try {
    const fixedClaim = route === "/v1/player-proofs/claim";
    const leagueInvitation = /^\/v1\/player-proofs\/league-invitation(?:\/revoke)?$/.test(route);
    const fixedInvitation = leagueInvitation || /^\/v1\/player-proofs\/invitation(?:\/revoke)?$/.test(route);
    const ids: Record<string, string> = {};
    if (fixedClaim || fixedInvitation) {
      const expected = fixedClaim ? ["playerId"] : leagueInvitation ? ["leagueId", "playerId"] : ["gameId", "playerId"];
      const fields = (input.rawQueryString ?? "").split("&");
      if (fields.length !== expected.length) return invalid();
      // Decode opaque identifiers exactly once. URLSearchParams can silently
      // replace malformed UTF-8 with another identity; route segments also lose
      // encoded slashes at API Gateway. Neither is safe for ownership operations.
      for (const field of fields) {
        const separator = field.indexOf("=");
        if (separator < 0) return invalid();
        const key = decodeURIComponent(field.slice(0, separator).replaceAll("+", " "));
        const value = decodeURIComponent(field.slice(separator + 1).replaceAll("+", " "));
        encodeURIComponent(value);
        const prefix = key === "gameId" ? "GAME#" : key === "leagueId" ? "LEAGUE#" : "PLAYER#";
        if (!expected.includes(key) || Object.hasOwn(ids, key) || !value.trim() || Buffer.byteLength(`${prefix}${value}`) > 2048) return invalid();
        ids[key] = value;
      }
    }
    if (method === "POST" && route === "/v1/player-proofs/preview") {
      const parsed = playerProofCredentialSchema.safeParse(body);
      if (!parsed.success) return invalid();
      return { statusCode: 200, payload: {
        preview: await repository.previewPlayerProof({ ...parsed.data, userId, sessionId: session.sessionId }),
        // Display and binding must originate from the same resolved session.
        // A separate session probe can race an account switch in another tab.
        account: { id: userId, email: session.email },
      } };
    }
    const claim = /^\/v1\/players\/([^/]+)\/claim$/.exec(route);
    if (method === "POST" && (claim || fixedClaim)) {
      const parsed = claimPlayerRequestSchema.safeParse(body);
      if (!parsed.success) return invalid();
      const playerId = fixedClaim ? ids.playerId : decodeURIComponent(claim![1]);
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
    if (invitation || fixedInvitation) {
      const context = leagueInvitation ? { scope: "league" as const, leagueId: ids.leagueId, playerId: ids.playerId, userIds } :
        { gameId: fixedInvitation ? ids.gameId : decodeURIComponent(invitation![1]),
          playerId: fixedInvitation ? ids.playerId : decodeURIComponent(invitation![2]), userIds };
      const revoke = fixedInvitation ? route.endsWith("/revoke") : Boolean(invitation![3]);
      // Repository context/transaction checks remain the authority boundary for
      // both transports; caller-supplied IDs never supply league permissions.
      if (method === "GET" && !revoke) return { statusCode: 200, payload: { invitation: await repository.getPlayerInvitation(context) } };
      if (method === "POST" && revoke) {
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
    if (error instanceof PlayerIdentityError) return { statusCode: error.status, payload: {
      error: error.category, code: error.code, message: error.message,
    } };
    if (error instanceof PlayerProofError) return { statusCode: error.statusCode, payload: {
      error: error.statusCode === 400 ? "bad_request" : error.statusCode === 403 ? "forbidden" : error.statusCode === 404 ? "not_found" : error.statusCode === 503 ? "unavailable" : "conflict",
      code: error.code, message: error.message,
    } };
    throw error;
  }
}
