import type {
  GameResult,
  TeamId,
  ThirdLengthMinutes,
  ThirdNumber,
  ThirdTimerSegment,
} from "@3fc/contracts";

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

export interface GameTeamRecord {
  gameId: string;
  teamId: TeamId;
  name: string;
  color: string | null;
  scored: number;
  conceded: number;
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
  joinCode: string;
  createRequestHash?: string;
  leagueId: string;
  seasonId: string;
  sessionId: string;
  status: GameStatus;
  gameStartTs: string;
  thirdLengthMinutes: ThirdLengthMinutes;
  thirds: ThirdTimerSegment[];
  finishedAt: string | null;
  result: GameResult | null;
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

export interface GameJoinCodeRecord {
  joinCode: string;
  gameId: string;
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

export interface GamePlayerRecord {
  gameId: string;
  playerId: string;
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

export type LeagueInviteKind = "share" | "email";

export interface LeagueInviteRecord {
  leagueId: string;
  inviteCode: string;
  kind: LeagueInviteKind;
  role: "admin";
  email: string | null;
  createdByUserId: string;
  acceptedByUserId: string | null;
  acceptedAt: string | null;
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
  thirdMinute: number;
  gameMinute: number;
  elapsedSeconds: number;
  stoppageMinute: number | null;
  displayTime: string;
  scoringTeamId: TeamId | null;
  concedingTeamId: TeamId;
  scorerPlayerId: string;
  assistPlayerIds: string[];
  ownGoal: boolean;
  createdAt: string;
  updatedAt: string;
}

export type GoalAuditAction =
  | "goal_created"
  | "goal_updated"
  | "goal_deleted"
  | "goal_undo_last";

export interface GoalAuditSnapshotRecord {
  eventId: string;
  third: 1 | 2 | 3;
  thirdMinute: number;
  gameMinute: number;
  elapsedSeconds: number;
  stoppageMinute: number | null;
  displayTime: string;
  scoringTeamId: TeamId | null;
  concedingTeamId: TeamId;
  scorerPlayerId: string;
  assistPlayerIds: string[];
  ownGoal: boolean;
}

export interface GoalAuditRecord {
  auditId: string;
  gameId: string;
  eventId: string;
  actorUserId: string;
  action: GoalAuditAction;
  before: GoalAuditSnapshotRecord | null;
  after: GoalAuditSnapshotRecord | null;
  createdAt: string;
  updatedAt: string;
}

export interface GoalStateRecord {
  gameId: string;
  latestEventId: string | null;
  latestGoalSk: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface GoalCorrectionOperationRecord {
  gameId: string;
  eventId: string;
  operationId: string;
  requestHash: string;
  action: Extract<GoalAuditAction, "goal_updated" | "goal_deleted" | "goal_undo_last">;
  result: UpdateGoalResult | DeleteGoalResult;
  createdAt: string;
  updatedAt: string;
}

export interface IdempotencyRecord {
  scope: string;
  key: string;
  requestHash: string;
  responseStatusCode: number;
  responseBody: string;
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
  createOnly?: boolean;
}

export interface CreateGameTeamInput {
  gameId: string;
  teamId: TeamId;
  name: string;
  color?: string | null;
  allowFinished?: boolean;
  createOnly?: boolean;
}

export interface CreateSessionInput {
  seasonId: string;
  sessionId: string;
  sessionDate: string;
}

export interface CreateGameInput {
  gameId: string;
  joinCode?: string | null;
  createRequestHash?: string | null;
  leagueId: string;
  seasonId: string;
  sessionId: string;
  status?: GameStatus;
  gameStartTs: string;
  thirdLengthMinutes?: ThirdLengthMinutes;
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

export interface CreateAndLinkGamePlayerInput extends CreatePlayerInput {
  gameId: string;
  allowFinished?: boolean;
}

export interface ListPlayersInput {
  search?: string | null;
  limit?: number;
}

export interface LinkGamePlayerInput {
  gameId: string;
  playerId: string;
  allowFinished?: boolean;
}

export interface JoinGameByCodeInput {
  joinCode: string;
  playerId: string;
  nickname: string;
}

export interface JoinGameByCodeResult {
  game: GameRecord;
  player: PlayerRecord;
  link: GamePlayerRecord;
}

export interface ClaimPlayerInput {
  playerId: string;
  userId: string;
}

export interface GrantLeagueAccessInput {
  leagueId: string;
  userId: string;
  role: LeagueRole;
  grantedByUserId: string;
}

export interface CreateLeagueOrganiserInviteInput {
  leagueId: string;
  email?: string | null;
  createdByUserId: string;
  inviteCode?: string | null;
  kind?: LeagueInviteKind;
}

export interface AcceptLeagueOrganiserInviteInput {
  inviteCode: string;
  userId: string;
  email: string;
}

export interface AcceptLeagueOrganiserInviteResult {
  invite: LeagueInviteRecord;
  access: LeagueAclRecord;
}

export interface AssignRosterInput {
  gameId: string;
  teamId: TeamId;
  playerId: string;
  allowFinished?: boolean;
}

export interface CreateGoalInput {
  gameId: string;
  eventId: string;
  actorUserId: string;
  allowFinished?: boolean;
  scoringTeamId: TeamId | null;
  concedingTeamId: TeamId;
  scorerPlayerId: string;
  assistPlayerIds: string[];
  ownGoal: boolean;
}

export interface CreateGoalResult {
  goal: GoalEventRecord;
  scoreboard: {
    teams: GameTeamRecord[];
  };
  timeline: GoalEventRecord[];
}

export interface UpdateGoalInput {
  gameId: string;
  eventId: string;
  actorUserId: string;
  operationId?: string | null;
  operationRequestHash?: string | null;
  allowFinished?: boolean;
  scoringTeamId?: TeamId | null;
  concedingTeamId?: TeamId;
  scorerPlayerId?: string;
  assistPlayerIds?: string[];
  ownGoal?: boolean;
}

export interface UpdateGoalResult {
  goal: GoalEventRecord;
  previousGoal: GoalEventRecord;
  scoreboard: {
    teams: GameTeamRecord[];
  };
  timeline: GoalEventRecord[];
  audit: GoalAuditRecord;
}

export interface DeleteGoalInput {
  gameId: string;
  eventId: string;
  actorUserId: string;
  operationId?: string | null;
  operationRequestHash?: string | null;
  allowFinished?: boolean;
  action?: Extract<GoalAuditAction, "goal_deleted" | "goal_undo_last">;
  expectedLatestEventId?: string;
}

export interface DeleteGoalResult {
  deletedGoal: GoalEventRecord;
  scoreboard: {
    teams: GameTeamRecord[];
  };
  timeline: GoalEventRecord[];
  audit: GoalAuditRecord;
}

export interface UndoLastGoalInput {
  gameId: string;
  actorUserId: string;
  operationId?: string | null;
  operationRequestHash?: string | null;
  allowFinished?: boolean;
  expectedEventId: string;
}

export interface FinishGameInput {
  gameId: string;
}

export interface ThirdTransitionInput {
  gameId: string;
  third: ThirdNumber;
}

export interface CreateIdempotencyRecordInput {
  scope: string;
  key: string;
  requestHash: string;
  responseStatusCode: number;
  responseBody: string;
}

export interface CompleteIdempotencyRecordInput extends CreateIdempotencyRecordInput {
  expectedResponseStatusCode: number;
  expectedResponseBody: string;
  expectedUpdatedAt?: string;
}

export interface DeleteIdempotencyRecordInput {
  scope: string;
  key: string;
  requestHash: string;
  responseStatusCode: number;
  responseBody: string;
  updatedAt?: string;
}
