import { z } from "zod";
import { TEAM_IDS } from "@3fc/contracts";
import type { AuthSessionRecord } from "./auth/magic-link.js";
import { idempotencyKeyHeaderSchema, isJoinCodePathParamValid, normalizeJoinCodePathParam } from "./contracts/core-write.js";
import { PlayerIdentityError, validPlayerIdentityId } from "./data/player-identity.js";
import type { ThreeFcRepository } from "./data/repository.js";

export type OwnedPlayerJoinRepository = Pick<ThreeFcRepository, "listOwnedJoinPlayers" | "joinOwnedPlayer">;
const playerId = z.string().refine(validPlayerIdentityId);
const reference = z.string().min(1);
const accountId = z.string().min(1).max(2048);
const team = z.object({ teamId: z.enum(TEAM_IDS), name: reference, color: reference.nullable() }).strict().nullable();
export const ownedJoinPageSchema = z.object({ accountId, gameId: reference, leagueId: reference,
  players: z.array(z.object({ playerId, nickname: reference, registeredPlayerId: playerId.nullable(), team,
    seasons: z.array(z.object({ seasonId: reference, name: reference }).strict()).max(3),
  }).strict()).max(20), cursor: z.string().min(1).max(8000).nullable(), complete: z.boolean(),
}).strict().refine(page => page.complete === (page.cursor === null));
export const ownedJoinResultSchema = z.object({ accountId, gameId: reference, joinCode: reference,
  player: z.object({ playerId, nickname: reference }).strict(),
  link: z.object({ gameId: reference, playerId }).strict(), alreadyRegistered: z.boolean(), team,
}).strict().refine(result => result.link.gameId === result.gameId && result.link.playerId === result.player.playerId);
const requestSchema = z.object({ playerId, expectedAccountId: accountId }).strict();

export function isOwnedPlayerJoinRoute(method: string, route: string): boolean {
  return (method === "GET" && /^\/v1\/join\/[^/]+\/linked-players$/.test(route)) ||
    (method === "POST" && /^\/v1\/join\/[^/]+\/linked-player$/.test(route));
}

function fields(raw: string): Record<string, string> {
  if (raw.length > 9000) throw new URIError();
  const result: Record<string, string> = Object.create(null);
  if (!raw) return result;
  for (const item of raw.split("&")) {
    const separator = item.indexOf("="); if (separator < 0) throw new URIError();
    const key = decodeURIComponent(item.slice(0, separator).replaceAll("+", " "));
    const value = decodeURIComponent(item.slice(separator + 1).replaceAll("+", " "));
    if (!["cursor", "limit"].includes(key) || Object.hasOwn(result, key)) throw new URIError();
    result[key] = value;
  }
  return result;
}

export async function handleOwnedPlayerJoinRoute(input: {
  method: string; route: string; rawQueryString?: string; body: unknown; idempotencyKey?: unknown;
  session: AuthSessionRecord | null; repository: OwnedPlayerJoinRepository;
}): Promise<{ statusCode: number; payload: Record<string, unknown> }> {
  const { session, repository, method, route } = input;
  if (!session) return { statusCode: 401, payload: { error: "unauthorized", message: "Sign in to continue." } };
  const userId = session.subject ?? session.email;
  const userIds = [...new Set([userId, session.email])];
  const invalid = () => ({ statusCode: 400, payload: { error: "bad_request", message: "Check the player and join link, then try again." } });
  try {
    if (!isOwnedPlayerJoinRoute(method, route)) return { statusCode: 404, payload: { error: "not_found", message: "Not found." } };
    const joinCode = normalizeJoinCodePathParam(decodeURIComponent(route.split("/")[3]));
    if (!isJoinCodePathParamValid(joinCode)) return invalid();
    if (method === "GET") {
      const query = fields(input.rawQueryString ?? "");
      if ((query.cursor !== undefined && (!query.cursor || query.cursor.length > 8000)) ||
          (query.limit !== undefined && !/^(?:[1-9]|1[0-9]|20)$/.test(query.limit))) return invalid();
      const page = await repository.listOwnedJoinPlayers({ joinCode, userId, userIds, cursor: query.cursor,
        limit: query.limit === undefined ? undefined : Number(query.limit) });
      const payload = ownedJoinPageSchema.parse(page);
      if (payload.accountId !== userId) throw new Error("Owned-player response account mismatch");
      return { statusCode: 200, payload };
    }
    if (input.rawQueryString) return invalid();
    const parsed = requestSchema.safeParse(input.body);
    if (!parsed.success) return invalid();
    if (parsed.data.expectedAccountId !== userId) return { statusCode: 403, payload: { error: "forbidden", code: "account_changed",
      message: "Your sign-in changed. Reload before continuing." } };
    const key = idempotencyKeyHeaderSchema.safeParse(input.idempotencyKey);
    if (!key.success) return invalid();
    // The repository receipt is committed with membership. Do not put a generic
    // response cache ahead of current account, ownership and live-game checks.
    const result = await repository.joinOwnedPlayer({ joinCode, userId, userIds, playerId: parsed.data.playerId, idempotencyKey: key.data });
    const payload = ownedJoinResultSchema.parse(result);
    if (payload.accountId !== userId || payload.joinCode !== joinCode) throw new Error("Owned-player response scope mismatch");
    return { statusCode: 200, payload };
  } catch (error) {
    if (error instanceof URIError) return invalid();
    if (error instanceof PlayerIdentityError) return { statusCode: error.status,
      payload: { error: error.category, code: error.code, message: error.message } };
    const failure = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
    if (failure?.name === "ConditionalCheckFailedException" || (failure?.name === "TransactionCanceledException" &&
        failure.CancellationReasons?.some(reason => reason.Code === "ConditionalCheckFailed") &&
        failure.CancellationReasons.every(reason => !reason.Code || ["None", "ConditionalCheckFailed"].includes(reason.Code)))) {
      return { statusCode: 409, payload: { error: "conflict", code: "linked_player_changed", message: "Your player details changed. Reload and try again." } };
    }
    throw error;
  }
}
