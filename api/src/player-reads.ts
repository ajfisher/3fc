import {
  isJoinCodePathParamValid,
  joinPlayerContextResponseSchema,
  normalizeJoinCodePathParam,
  publicPlayerSchema,
  type PublicPlayer,
} from "./contracts/core-write.js";
import type { GamePlayerRecord, RosterAssignmentRecord } from "./data/types.js";

type PlayerSource = { playerId: string; nickname: string; createdAt: string; updatedAt: string };
export interface PlayerReadRepository {
  getGameByJoinCode(code: string): Promise<{ gameId: string; joinCode: string } | null>;
  getGamePlayer(gameId: string, playerId: string): Promise<GamePlayerRecord | null>;
  getPlayer(playerId: string, options?: { consistentRead?: boolean }): Promise<PlayerSource | null>;
  listGamePlayers(gameId: string, options?: { complete?: boolean; consistentRead?: boolean }): Promise<GamePlayerRecord[]>;
  listGameRoster(gameId: string, options?: { complete?: boolean; consistentRead?: boolean }): Promise<RosterAssignmentRecord[]>;
}

function publicPlayer(player: PlayerSource): PublicPlayer {
  return publicPlayerSchema.parse({
    playerId: player.playerId, nickname: player.nickname,
    createdAt: player.createdAt, updatedAt: player.updatedAt,
  });
}

export function unavailableJoinPlayerContext() {
  return { statusCode: 503, payload: { error: "unavailable", message: "Player details could not be loaded. Try again." } };
}

// Authentication is enforced by each route adapter. Code + exact membership
// supplies display context only; this function cannot claim or grant access.
export async function readJoinPlayerContext(repository: PlayerReadRepository, rawCode: string, rawPlayerId: string) {
  let joinCode: string;
  let playerId: string;
  try {
    joinCode = normalizeJoinCodePathParam(decodeURIComponent(rawCode));
    playerId = decodeURIComponent(rawPlayerId);
    if (!isJoinCodePathParamValid(joinCode) || !playerId.trim()) throw new Error("invalid_context");
  } catch {
    return { statusCode: 400, payload: { error: "bad_request", message: "This player link is invalid." } };
  }
  const unavailable = { statusCode: 404, payload: { error: "not_found", message: "This player link is unavailable." } };
  try {
    const game = await repository.getGameByJoinCode(joinCode);
    if (!game || normalizeJoinCodePathParam(game.joinCode) !== joinCode) return unavailable;
    const link = await repository.getGamePlayer(game.gameId, playerId);
    if (!link || link.gameId !== game.gameId || link.playerId !== playerId) return unavailable;
    const player = await repository.getPlayer(playerId, { consistentRead: true });
    if (!player || player.playerId !== playerId) return unavailable;
    return { statusCode: 200, payload: joinPlayerContextResponseSchema.parse({ gameId: game.gameId, joinCode, player: publicPlayer(player) }) };
  } catch {
    return unavailableJoinPlayerContext();
  }
}

export async function readRosterPlayerData(repository: PlayerReadRepository, gameId: string) {
  const options = { complete: true, consistentRead: true };
  const roster = await repository.listGameRoster(gameId, options);
  const links = await repository.listGamePlayers(gameId, options);
  if (roster.some((entry) => entry.gameId !== gameId) || links.some((entry) => entry.gameId !== gameId)) {
    throw new Error("Roster membership could not be confirmed.");
  }
  const assignedIds = new Set(roster.map((entry) => entry.playerId));
  const linkedIds = new Set(links.map((entry) => entry.playerId));
  const ids = [...new Set([...assignedIds, ...linkedIds])];
  const playersById = new Map<string, PublicPlayer>();
  let next = 0;
  let failed = false;
  // Bound DynamoDB profile fan-out independently of game size; no new IAM or
  // BatchGet dependency is needed. Missing joined profiles cannot become empty.
  await Promise.all(Array.from({ length: Math.min(8, ids.length) }, async () => {
    for (;;) {
      if (failed) return;
      const index = next++;
      if (index >= ids.length) return;
      const id = ids[index];
      try {
        const player = await repository.getPlayer(id, { consistentRead: true });
        if (!player) {
          if (linkedIds.has(id)) throw new Error("Joined player details could not be loaded.");
          continue;
        }
        if (player.playerId !== id) throw new Error("Player identity could not be confirmed.");
        playersById.set(id, publicPlayer(player));
      } catch {
        failed = true;
        return;
      }
    }
  }));
  if (failed) throw new Error("Roster player details could not be loaded.");
  const unassignedPlayers = [...linkedIds].filter((id) => !assignedIds.has(id))
    .map((id) => playersById.get(id)!)
    .sort((left, right) => left.nickname.localeCompare(right.nickname) || left.playerId.localeCompare(right.playerId));
  return { roster, playersById, unassignedPlayers };
}
