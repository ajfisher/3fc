import type { TeamId } from "@3fc/contracts";

export type GameStatus = "scheduled" | "live" | "finished";
export type LeagueRole = "admin" | "scorekeeper" | "viewer";

export interface LeagueRecord {
  leagueId: string;
  name: string;
  slug: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface SeasonRecord {
  leagueId: string;
  seasonId: string;
  name: string;
  slug: string | null;
  startsOn: string | null;
  endsOn: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamRecord {
  seasonId: string;
  teamId: TeamId;
  name: string;
  color: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  seasonId: string;
  sessionId: string;
  sessionDate: string;
  createdAt: string;
  updatedAt: string;
}

export interface GameRecord {
  gameId: string;
  leagueId: string;
  seasonId: string;
  sessionId: string;
  status: GameStatus;
  gameStartTs: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionGameRecord {
  sessionId: string;
  gameId: string;
  gameStartTs: string;
  leagueId: string;
  seasonId: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlayerRecord {
  playerId: string;
  nickname: string;
  claimedByUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeagueAclRecord {
  leagueId: string;
  userId: string;
  role: LeagueRole;
  grantedByUserId: string;
  createdAt: string;
  updatedAt: string;
}

export interface RosterAssignmentRecord {
  gameId: string;
  teamId: TeamId;
  playerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface GoalEventRecord {
  gameId: string;
  eventId: string;
  third: 1 | 2 | 3;
  gameMinute: number;
  scoringTeamId: TeamId | null;
  concedingTeamId: TeamId;
  scorerPlayerId: string;
  assistPlayerIds: string[];
  ownGoal: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLeagueInput {
  leagueId: string;
  name: string;
  slug?: string | null;
  createdByUserId: string;
}

export interface CreateSeasonInput {
  leagueId: string;
  seasonId: string;
  name: string;
  slug?: string | null;
  startsOn?: string | null;
  endsOn?: string | null;
}

export interface CreateTeamInput {
  seasonId: string;
  teamId: TeamId;
  name: string;
  color?: string | null;
}

export interface CreateSessionInput {
  seasonId: string;
  sessionId: string;
  sessionDate: string;
}

export interface CreateGameInput {
  gameId: string;
  leagueId: string;
  seasonId: string;
  sessionId: string;
  status?: GameStatus;
  gameStartTs: string;
}

export interface CreateSessionGameInput {
  sessionId: string;
  gameId: string;
  gameStartTs: string;
  leagueId: string;
  seasonId: string;
}

export interface CreatePlayerInput {
  playerId: string;
  nickname: string;
  claimedByUserId?: string | null;
}

export interface GrantLeagueAccessInput {
  leagueId: string;
  userId: string;
  role: LeagueRole;
  grantedByUserId: string;
}

export interface AssignRosterInput {
  gameId: string;
  teamId: TeamId;
  playerId: string;
}

export interface CreateGoalEventInput {
  gameId: string;
  eventId: string;
  third: 1 | 2 | 3;
  gameMinute: number;
  scoringTeamId: TeamId | null;
  concedingTeamId: TeamId;
  scorerPlayerId: string;
  assistPlayerIds: string[];
  ownGoal: boolean;
}
