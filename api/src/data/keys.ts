export const ENTITY_PK_PREFIX = {
  league: "LEAGUE#",
  season: "SEASON#",
  game: "GAME#",
  session: "SESSION#",
  player: "PLAYER#",
} as const;

export function leaguePk(leagueId: string): string {
  return `${ENTITY_PK_PREFIX.league}${leagueId}`;
}

export function seasonPk(seasonId: string): string {
  return `${ENTITY_PK_PREFIX.season}${seasonId}`;
}

export function seasonSk(seasonId: string): string {
  return `SEASON#${seasonId}`;
}

export function teamSk(teamId: string): string {
  return `TEAM#${teamId}`;
}

export function sessionSk(sessionId: string): string {
  return `SESSION#${sessionId}`;
}

export function gamePk(gameId: string): string {
  return `${ENTITY_PK_PREFIX.game}${gameId}`;
}

export function playerPk(playerId: string): string {
  return `${ENTITY_PK_PREFIX.player}${playerId}`;
}

export function metadataSk(): string {
  return "METADATA";
}

export function profileSk(): string {
  return "PROFILE";
}

export function aclSk(userId: string): string {
  return `ACL#USER#${userId}`;
}

export function rosterSk(teamId: string, playerId: string): string {
  return `ROSTER#${teamId}#${playerId}`;
}

export function gameSessionIndexPk(sessionId: string): string {
  return `${ENTITY_PK_PREFIX.session}${sessionId}`;
}

export function gameSessionIndexSk(gameStartTs: string, gameId: string): string {
  return `GAME#${gameStartTs}#${gameId}`;
}

export function goalSk(third: 1 | 2 | 3, gameMinute: number, eventId: string): string {
  const minuteSortable = String(gameMinute).padStart(4, "0");
  return `GOAL#${third}#${minuteSortable}#${eventId}`;
}
