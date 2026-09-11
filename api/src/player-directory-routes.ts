import { z } from "zod";
import { TEAM_IDS } from "@3fc/contracts";
import type { AuthSessionRecord } from "./auth/magic-link.js";
import { PlayerIdentityError } from "./data/player-identity.js";
import { GameMutationStateError, type ThreeFcRepository } from "./data/repository.js";

export type PlayerDirectoryRepository = Pick<ThreeFcRepository,
  "listLeaguePlayers" | "createLeaguePlayer" | "addExistingLeaguePlayer">;
// Opaque historical IDs are not limited by an arbitrary shared byte cap.
// The transaction planner checks the actual partition/sort keys for writes.
const identifier = (prefix: string, limit = 2048) => z.string().min(1).refine(value => {
  try { encodeURIComponent(value); } catch { return false; }
  return value.trim().length > 0 && Buffer.byteLength(`${prefix}${value}`) <= limit;
});
const id = identifier("PLAYER#"), leagueIdSchema = identifier("LEAGUE#"), gameIdSchema = identifier("GAME#");
const seasonIdSchema = identifier("SEASON#", 1024); // Scoped season metadata sort key.
export const createLeaguePlayerSchema = z.object({ playerId: id, nickname: z.string().trim().min(1).max(80) }).strict();
export const addExistingLeaguePlayerSchema = z.object({ playerId: id, teamId: z.enum(TEAM_IDS).nullable().optional(),
  allowFinished: z.boolean().optional() }).strict();
export const leaguePlayerPageSchema = z.object({ players: z.array(z.object({ playerId: id, nickname: z.string().min(1),
  claimed: z.boolean(), seasons: z.array(z.object({ seasonId: seasonIdSchema, name: z.string().min(1) }).strict()).max(3), hasMoreSeasons: z.boolean(), inGame: z.boolean().optional(),
}).strict()), cursor: z.string().nullable() }).strict();

export function isPlayerDirectoryRoute(method: string, route: string): boolean {
  return ((method === "GET" || method === "POST") && route === "/v1/league-players") ||
    (method === "POST" && route === "/v1/game-player-registrations");
}

function queryFields(raw: string, allowed: readonly string[]): Record<string, string> {
  if (!raw || raw.length > 16_000) throw new URIError();
  const result: Record<string, string> = Object.create(null);
  for (const field of raw.split("&")) {
    const separator = field.indexOf("=");
    if (separator < 0) throw new URIError();
    const key = decodeURIComponent(field.slice(0, separator).replaceAll("+", " "));
    const value = decodeURIComponent(field.slice(separator + 1).replaceAll("+", " "));
    // Decode once and reject replacement/invalid Unicode rather than changing an
    // opaque identity. Fixed routes survive API Gateway's encoded-slash handling.
    encodeURIComponent(value);
    if (!allowed.includes(key) || Object.hasOwn(result, key)) throw new URIError();
    result[key] = value;
  }
  return result;
}

export async function handlePlayerDirectoryRoute(input: {
  method: string; route: string; rawQueryString?: string; body: unknown;
  session: AuthSessionRecord | null; repository: PlayerDirectoryRepository;
}): Promise<{ statusCode: number; payload: Record<string, unknown> }> {
  const { method, route, repository, session } = input;
  if (!session) return { statusCode: 401, payload: { error: "unauthorized", message: "Sign in to continue." } };
  const userIds = [...new Set([session.subject ?? session.email, session.email])];
  const invalid = () => ({ statusCode: 400, payload: { error: "bad_request", message: "Check the player details and try again." } });
  try {
    if (route === "/v1/league-players") {
      const fields = queryFields(input.rawQueryString ?? "", method === "GET" ? ["leagueId", "seasonId", "gameId", "query", "cursor", "limit"] : ["leagueId"]);
      if (!leagueIdSchema.safeParse(fields.leagueId).success) return invalid();
      if (method === "GET") {
        if ((fields.seasonId !== undefined && !seasonIdSchema.safeParse(fields.seasonId).success) ||
            (fields.gameId !== undefined && !gameIdSchema.safeParse(fields.gameId).success) ||
            (fields.query !== undefined && fields.query.length > 100) ||
            (fields.cursor !== undefined && (!fields.cursor || fields.cursor.length > 8000)) ||
            (fields.limit !== undefined && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(fields.limit))) return invalid();
        const page = await repository.listLeaguePlayers({ leagueId: fields.leagueId, userIds, seasonId: fields.seasonId, gameId: fields.gameId,
          query: fields.query, cursor: fields.cursor, limit: fields.limit === undefined ? undefined : Number(fields.limit) });
        return { statusCode: 200, payload: leaguePlayerPageSchema.parse(page) };
      }
      if (method === "POST") {
        const body = createLeaguePlayerSchema.safeParse(input.body);
        if (!body.success) return invalid();
        return { statusCode: 201, payload: { player: await repository.createLeaguePlayer({ ...body.data, leagueId: fields.leagueId, userIds }) } };
      }
    }
    if (route === "/v1/game-player-registrations" && method === "POST") {
      const fields = queryFields(input.rawQueryString ?? "", ["gameId"]);
      const body = addExistingLeaguePlayerSchema.safeParse(input.body);
      if (!body.success || !gameIdSchema.safeParse(fields.gameId).success) return invalid();
      const registration = await repository.addExistingLeaguePlayer({ ...body.data, gameId: fields.gameId, userIds });
      return { statusCode: 200, payload: { registration } };
    }
    return { statusCode: 404, payload: { error: "not_found", message: "Not found." } };
  } catch (error) {
    if (error instanceof URIError) return invalid();
    if (error instanceof PlayerIdentityError) return { statusCode: error.status,
      payload: { error: error.category, code: error.code, message: error.message } };
    if (error instanceof GameMutationStateError) return { statusCode: 409,
      payload: { error: "conflict", code: error.code, message: error.message } };
    // A cancelled transaction is retryable only if DynamoDB identifies a
    // condition conflict. Capacity/validation failures must not masquerade as it.
    const failure = error as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
    if (failure?.name === "ConditionalCheckFailedException" || (failure?.name === "TransactionCanceledException" &&
        failure.CancellationReasons?.some(reason => reason.Code === "ConditionalCheckFailed") &&
        failure.CancellationReasons.every(reason => !reason.Code || ["None", "ConditionalCheckFailed"].includes(reason.Code)))) {
      return { statusCode: 409, payload: { error: "conflict", code: "player_list_changed", message: "The player list changed. Refresh and try again." } };
    }
    throw error;
  }
}
