import { z } from "zod";
import type { AuthSessionRecord } from "./auth/magic-link.js";
import { PlayerIdentityError, validPlayerIdentityId } from "./data/player-identity.js";
import type { ThreeFcRepository } from "./data/repository.js";

export type PlayerConsolidationRepository = Pick<ThreeFcRepository,
  "previewPlayerConsolidation" | "getPlayerConsolidation" | "decidePlayerConsolidation" | "commitPlayerConsolidation">;
const proposalId = z.string().regex(/^[A-Za-z0-9_-]{20,64}$/);
const playerId = z.string().refine(validPlayerIdentityId);
const expectedAccountId = z.string().min(1).max(2048);
const reference = z.object({ proposalId, expectedAccountId }).strict();
const preview = z.object({ proposalId, expectedAccountId, leagueId: z.string().min(1).refine(value => {
  try { encodeURIComponent(value); } catch { return false; }
  return value.trim().length > 0 && Buffer.byteLength(`LEAGUE#${value}`) <= 2048;
}), playerIds: z.array(playerId).min(2).max(20).refine(ids => new Set(ids).size === ids.length),
retainedPlayerId: playerId, nickname: z.string().trim().min(1).max(80) }).strict();
const decision = reference.extend({ decision: z.enum(["approve", "decline"]) }).strict();
export const consolidationResponseSchema = z.object({ proposal: z.object({
  proposalId, leagueId: z.string().min(1), leagueName: z.string().min(1), retainedPlayerId: playerId,
  nickname: z.string().min(1).max(80), status: z.enum(["pending_approval", "ready", "declined", "committed", "stale"]),
  profiles: z.array(z.object({ playerId, nickname: z.string().min(1), claimed: z.boolean(),
    games: z.array(z.object({ gameId: z.string().min(1), kickoffAt: z.string().refine(value => Number.isFinite(Date.parse(value))) }).strict()),
  }).strict()).min(2).max(20),
  blockers: z.array(z.object({ code: z.string().min(1), message: z.string().min(1) }).strict()),
  requiresApproval: z.boolean(), canApprove: z.boolean(), canCommit: z.boolean(),
}).strict() }).strict();

export function isPlayerConsolidationRoute(method: string, route: string): boolean {
  return ((method === "GET" || method === "POST") && route === "/v1/player-consolidations") ||
    (method === "POST" && ["/v1/player-consolidations/approve", "/v1/player-consolidations/commit"].includes(route));
}

export async function handlePlayerConsolidationRoute(input: {
  method: string; route: string; rawQueryString?: string; body: unknown;
  session: AuthSessionRecord | null; repository: PlayerConsolidationRepository;
}): Promise<{ statusCode: number; payload: Record<string, unknown> }> {
  const { session, repository, method, route } = input;
  if (!session) return { statusCode: 401, payload: { error: "unauthorized", message: "Sign in to continue." } };
  const userIds = [...new Set([session.subject ?? session.email, session.email])];
  const invalid = () => ({ statusCode: 400, payload: { error: "bad_request", message: "Check the selected profiles and try again." } });
  try {
    let proposal;
    if (method === "GET") {
      const query = input.rawQueryString ?? "";
      if (!/^proposalId=[A-Za-z0-9_-]{20,64}$/.test(query)) return invalid();
      proposal = await repository.getPlayerConsolidation({ proposalId: query.slice("proposalId=".length), userIds });
    } else {
      if (input.rawQueryString) return invalid();
      const account = (input.body as { expectedAccountId?: unknown } | null)?.expectedAccountId;
      if (typeof account === "string" && account !== (session.subject ?? session.email)) {
        return { statusCode: 403, payload: { error: "forbidden", code: "account_changed",
          message: "Your sign-in changed. Reload before continuing." } };
      }
      if (route === "/v1/player-consolidations") {
        const parsed = preview.safeParse(input.body); if (!parsed.success) return invalid();
        const { expectedAccountId: _account, ...fields } = parsed.data;
        proposal = await repository.previewPlayerConsolidation({ ...fields, userIds });
      } else if (route === "/v1/player-consolidations/approve") {
        const parsed = decision.safeParse(input.body); if (!parsed.success) return invalid();
        const { expectedAccountId: _account, ...fields } = parsed.data;
        proposal = await repository.decidePlayerConsolidation({ ...fields, userIds });
      } else if (route === "/v1/player-consolidations/commit") {
        const parsed = reference.safeParse(input.body); if (!parsed.success) return invalid();
        proposal = await repository.commitPlayerConsolidation({ proposalId: parsed.data.proposalId, userIds });
      } else return { statusCode: 404, payload: { error: "not_found", message: "Not found." } };
    }
    return { statusCode: 200, payload: consolidationResponseSchema.parse({ proposal }) };
  } catch (error) {
    if (error instanceof PlayerIdentityError) return { statusCode: error.status,
      payload: { error: error.category, code: error.code, message: error.message } };
    const failure = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
    if (failure?.name === "ConditionalCheckFailedException" || (failure?.name === "TransactionCanceledException" &&
        failure.CancellationReasons?.some(reason => reason.Code === "ConditionalCheckFailed") &&
        failure.CancellationReasons.every(reason => !reason.Code || ["None", "ConditionalCheckFailed"].includes(reason.Code)))) {
      return { statusCode: 409, payload: { error: "conflict", code: "player_consolidation_changed",
        message: "These profiles changed. Review them again before combining." } };
    }
    throw error;
  }
}
