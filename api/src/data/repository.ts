import {
  DeleteItemCommand,
  GetItemCommand,
  type GetItemCommandOutput,
  PutItemCommand,
  QueryCommand,
  type QueryCommandOutput,
  ScanCommand,
  type ScanCommandOutput,
  TransactGetItemsCommand,
  type TransactGetItemsCommandOutput,
  TransactWriteItemsCommand,
  type AttributeValue,
  type TransactWriteItem,
} from "@aws-sdk/client-dynamodb";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { LeagueDeletionCleanup } from "./league-deletion.js";
import { PlayerConsolidationService } from "./player-consolidation.js";
import { readPlayerClaimsRevision, advancePlayerClaimsRevision } from "./player-claims-revision.js";
import { OwnedPlayerJoinService } from "./owned-player-join.js";
import { PlayerIdentityPlanner, PlayerIdentityError, boundedIdentityTransaction,
  identityCondition, identityDirectorySk, type IdentityControl, type IdentitySnapshot, type ResolvedPlayerIdentity } from "./player-identity.js";
import {
  createPlayerConfirmation, hashPlayerProofSecret, parsePlayerClaimMode,
  PlayerProofError, PLAYER_PROOF_TTL_MS, PROOF_ID_PATTERN, PROOF_VERIFIER_PATTERN,
  requirePlayerClaimEnabled, secureEqual, verifyPlayerConfirmation,
  type PlayerClaimMode,
} from "../auth/player-proof.js";
import {
  createDefaultThirdTimerSegments,
  DEFAULT_THIRD_LENGTH_MINUTES,
  formatThirdDisplayTime,
  isThirdLengthMinutes,
  THIRD_NUMBERS,
  validateAssistPlayerIds,
  TEAM_IDS,
  type GameResult,
  type TeamId,
  type ThirdLengthMinutes,
  type ThirdNumber,
  type ThirdTimerSegment,
} from "@3fc/contracts";

import {
  aclSk,
  gamePk,
  gamePlayerSk,
  gameSessionIndexPk,
  gameSessionIndexSk,
  goalAuditSk,
  goalCorrectionOperationSk,
  goalEventIdSk,
  goalStateSk,
  goalSk,
  idempotencyPk,
  joinCodePk,
  leagueInvitePk,
  leagueOrganiserShareInviteSk,
  leaguePk,
  metadataSk,
  playerClaimSk,
  playerPk,
  profileSk,
  rosterSk,
  scopedSeasonSessionSk,
  scopedSeasonTeamSk,
  seasonPk,
  seasonSk,
  sessionPk,
  sessionSk,
  teamSk,
  userPk,
} from "./keys.js";
import type {
  AssignRosterInput,
  ClaimPlayerInput,
  CreateAndLinkGamePlayerInput,
  CreateGameTeamInput,
  CreateGameInput,
  CreateGoalInput,
  CreateGoalResult,
  CompleteIdempotencyRecordInput,
  CreateIdempotencyRecordInput,
  CreateLeagueInput,
  CreateLeagueOrganiserInviteInput,
  CreatePlayerInput,
  CreateSeasonInput,
  CreateSessionGameInput,
  CreateSessionInput,
  CreateTeamInput,
  DeleteGoalInput,
  DeleteGoalResult,
  DeleteIdempotencyRecordInput,
  FinishGameInput,
  GameJoinCodeRecord,
  GameTeamRecord,
  GamePlayerRecord,
  GameRecord,
  GoalAuditAction,
  GoalAuditRecord,
  GoalAuditSnapshotRecord,
  GoalCorrectionOperationRecord,
  GoalEventRecord,
  GoalStateRecord,
  IdempotencyRecord,
  JoinGameByCodeInput,
  JoinGameByCodeResult,
  LeagueAclRecord,
  LeagueInviteRecord,
  LeagueRecord,
  ListPlayersInput,
  LinkGamePlayerInput,
  PlayerRecord,
  PlayerProofCreation,
  PlayerProofCredential,
  PlayerProofMetadata,
  PlayerProofPreview,
  PlayerProofRecord,
  RosterAssignmentRecord,
  SeasonRecord,
  SessionGameRecord,
  SessionRecord,
  TeamRecord,
  GrantLeagueAccessInput,
  AcceptLeagueOrganiserInviteInput,
  AcceptLeagueOrganiserInviteResult,
  ThirdTransitionInput,
  UndoLastGoalInput,
  UpdateGoalInput,
  UpdateGoalResult,
} from "./types.js";

const ENTITY_TYPE = {
  league: "league",
  season: "season",
  team: "team",
  session: "session",
  game: "game",
  gameTeam: "gameTeam",
  gamePlayer: "gamePlayer",
  gameJoinCode: "gameJoinCode",
  sessionGame: "sessionGame",
  player: "player",
  playerClaim: "playerClaim",
  playerProof: "playerProof",
  playerProofPointer: "playerProofPointer",
  gameJoinReceipt: "gameJoinReceipt",
  acl: "acl",
  leaguePlayer: "leaguePlayer",
  leaguePlayerCreation: "leaguePlayerCreation",
  leagueInvite: "leagueInvite",
  leagueInvitePointer: "leagueInvitePointer",
  roster: "roster",
  goal: "goal",
  goalEventId: "goalEventId",
  goalState: "goalState",
  goalAudit: "goalAudit",
  goalCorrectionOperation: "goalCorrectionOperation",
  idempotency: "idempotency",
} as const;

type EntityType = (typeof ENTITY_TYPE)[keyof typeof ENTITY_TYPE];

type Item = Record<string, AttributeValue>;
type PlayerInvitationTarget = { playerId: string; userIds: readonly string[] } &
  ({ scope?: "game"; gameId: string; leagueId?: never } | { scope: "league"; leagueId: string; gameId?: never });

interface Clock {
  now(): string;
}

interface DynamoCommandClient {
  send(command: unknown): Promise<unknown>;
}

interface QueryByPrefixOptions {
  consistentRead?: boolean;
}

interface StoredEntity<T> {
  pk: string;
  sk: string;
  entityType: EntityType;
  createdAt: string;
  updatedAt: string;
  rawData: string;
  data: T;
}

class DefaultClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}

export class GameTimerTransitionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "GameTimerTransitionError";
  }
}

export class GoalCreationError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: 400 | 409,
    message: string,
  ) {
    super(message);
    this.name = "GoalCreationError";
  }
}

export class GoalCorrectionError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: 400 | 409,
    message: string,
  ) {
    super(message);
    this.name = "GoalCorrectionError";
  }
}

export class GameMutationStateError extends Error {
  constructor(
    readonly code: "game_finished" | "game_state_changed",
    message: string,
  ) {
    super(message);
    this.name = "GameMutationStateError";
  }
}

export class GameJoinCodeCollisionError extends Error {
  constructor(message = "Join code is already assigned to another game.") {
    super(message);
    this.name = "GameJoinCodeCollisionError";
  }
}

export class GameAlreadyExistsError extends Error {
  constructor(gameId: string) {
    super(`Game ${gameId} already exists.`);
    this.name = "GameAlreadyExistsError";
  }
}

export class GameJoinRegistrationError extends Error {
  constructor(
    readonly code: "game_finished" | "join_state_changed",
    readonly statusCode: 409,
    message: string,
  ) {
    super(message);
    this.name = "GameJoinRegistrationError";
  }
}

export class PlayerClaimError extends Error {
  constructor(
    readonly code: "player_already_claimed" | "claim_state_changed",
    readonly statusCode: 409,
    message: string,
  ) {
    super(message);
    this.name = "PlayerClaimError";
  }
}

export class LeagueInviteCodeCollisionError extends Error {
  constructor(message = "League organiser invite code is already assigned.") {
    super(message);
    this.name = "LeagueInviteCodeCollisionError";
  }
}

export class LeagueInviteError extends Error {
  constructor(
    readonly code:
      | "invite_already_accepted"
      | "invite_email_mismatch"
      | "invite_scope_not_found"
      | "invite_state_changed",
    readonly statusCode: 403 | 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = "LeagueInviteError";
  }
}

type GoalRuleErrorKind = "creation" | "correction";

function goalRuleError(
  kind: GoalRuleErrorKind,
  code: string,
  statusCode: 400 | 409,
  message: string,
): GoalCreationError | GoalCorrectionError {
  return kind === "creation"
    ? new GoalCreationError(code, statusCode, message)
    : new GoalCorrectionError(code, statusCode, message);
}

function requireNonEmpty(name: string, value: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
}

function requireLeagueRole(role: string): asserts role is LeagueAclRecord["role"] {
  if (role !== "admin" && role !== "scorekeeper" && role !== "viewer") {
    throw new Error("role must be admin, scorekeeper, or viewer.");
  }
}

function leagueRoleRank(role: LeagueAclRecord["role"]): number {
  if (role === "admin") {
    return 3;
  }
  if (role === "scorekeeper") {
    return 2;
  }
  return 1;
}

function higherLeagueRole(
  left: LeagueAclRecord["role"],
  right: LeagueAclRecord["role"],
): LeagueAclRecord["role"] {
  return leagueRoleRank(left) >= leagueRoleRank(right) ? left : right;
}

function requireThirdNumber(third: number): asserts third is ThirdNumber {
  if (!THIRD_NUMBERS.includes(third as ThirdNumber)) {
    throw new Error("third must be 1, 2, or 3.");
  }
}

function requireTeamId(teamId: string | null, fieldName: string): asserts teamId is TeamId {
  if (teamId === null || !TEAM_IDS.includes(teamId as TeamId)) {
    throw new GoalCreationError(
      "invalid_team",
      400,
      `${fieldName} must be red, blue, or yellow.`,
    );
  }
}

function requireGoalTeamId(
  teamId: string | null,
  fieldName: string,
  errorKind: GoalRuleErrorKind,
): asserts teamId is TeamId {
  if (teamId === null || !TEAM_IDS.includes(teamId as TeamId)) {
    throw goalRuleError(
      errorKind,
      "invalid_team",
      400,
      `${fieldName} must be red, blue, or yellow.`,
    );
  }
}

function isTeamId(value: unknown): value is TeamId {
  return typeof value === "string" && TEAM_IDS.includes(value as TeamId);
}

function normalizeThirdNumber(value: unknown): ThirdNumber {
  return typeof value === "number" && THIRD_NUMBERS.includes(value as ThirdNumber)
    ? (value as ThirdNumber)
    : 1;
}

function normalizeThirdLengthMinutes(value: unknown): ThirdLengthMinutes {
  return typeof value === "number" && isThirdLengthMinutes(value)
    ? value
    : DEFAULT_THIRD_LENGTH_MINUTES;
}

function normalizeThirdTimerSegments(value: unknown): ThirdTimerSegment[] {
  const source = Array.isArray(value) ? value : [];

  return THIRD_NUMBERS.map((third) => {
    const matchingSegment = source.find(
      (segment): segment is Partial<ThirdTimerSegment> =>
        typeof segment === "object" &&
        segment !== null &&
        (segment as { third?: unknown }).third === third,
    );

    return {
      third,
      startedAt: typeof matchingSegment?.startedAt === "string" ? matchingSegment.startedAt : null,
      finishedAt: typeof matchingSegment?.finishedAt === "string" ? matchingSegment.finishedAt : null,
    };
  });
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function shouldUseTeamCandidate(existing: TeamRecord | undefined, candidate: TeamRecord): boolean {
  if (!existing) {
    return true;
  }

  return candidate.updatedAt >= existing.updatedAt;
}

const JOIN_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const JOIN_CODE_LENGTH = 8;
const JOIN_CODE_GENERATION_ATTEMPTS = 8;
const LEGACY_JOIN_CODE_REPAIR_ATTEMPTS = 16;
const LEGACY_JOIN_CODE_REPAIR_RACE_RETRIES = 3;
const JOIN_CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/;

export function buildJoinCodeForGameId(gameId: string): string {
  const digest = createHash("sha256").update(`3fc:join:${gameId}`).digest();
  let joinCode = "";

  for (let index = 0; index < JOIN_CODE_LENGTH; index += 1) {
    joinCode += JOIN_CODE_ALPHABET[digest[index] % JOIN_CODE_ALPHABET.length];
  }

  return joinCode;
}

function generateJoinCode(): string {
  const bytes = randomBytes(JOIN_CODE_LENGTH);
  let joinCode = "";

  for (const byte of bytes) {
    joinCode += JOIN_CODE_ALPHABET[byte % JOIN_CODE_ALPHABET.length];
  }

  return joinCode;
}

function normalizeJoinCode(joinCode: string): string {
  return joinCode.trim().toUpperCase();
}

function normalizeCustomJoinCode(joinCode: string): string {
  const normalizedJoinCode = normalizeJoinCode(joinCode);
  if (!JOIN_CODE_PATTERN.test(normalizedJoinCode)) {
    throw new Error("joinCode must be 8 uppercase non-ambiguous letters or digits.");
  }

  return normalizedJoinCode;
}

function normalizeGameResultPayload(value: unknown): GameResult | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const raw = value as Partial<GameResult>;
  if (!Array.isArray(raw.teams)) {
    return null;
  }

  const winnerTeamId = raw.winnerTeamId ?? null;
  if (winnerTeamId !== null && !isTeamId(winnerTeamId)) {
    return null;
  }
  if (!isValidTimestamp(raw.computedAt)) {
    return null;
  }

  const teams = raw.teams
    .filter(
      (team): team is GameResult["teams"][number] =>
        typeof team === "object" &&
        team !== null &&
        isTeamId((team as { teamId?: unknown }).teamId),
    )
    .map((team) => ({
      teamId: team.teamId,
      name: typeof team.name === "string" ? team.name : "",
      color: typeof team.color === "string" ? team.color : null,
      scored: normalizeNonNegativeInteger(team.scored),
      conceded: normalizeNonNegativeInteger(team.conceded),
      rank: normalizePositiveInteger(team.rank),
      outcome:
        team.outcome === "win" || team.outcome === "draw" || team.outcome === "loss"
          ? team.outcome
          : "loss",
    }));
  const teamIds = new Set(teams.map((team) => team.teamId));
  if (teams.length !== TEAM_IDS.length || TEAM_IDS.some((teamId) => !teamIds.has(teamId))) {
    return null;
  }

  return {
    winnerTeamId,
    outcome: winnerTeamId ? "win" : "draw",
    comparator: "fewest_conceded_then_most_scored",
    computedAt: raw.computedAt,
    teams,
  };
}

function normalizeGamePayload(data: unknown): Omit<GameRecord, "createdAt" | "updatedAt"> {
  const raw = data as Partial<Omit<GameRecord, "createdAt" | "updatedAt">>;
  const createRequestHash =
    typeof raw.createRequestHash === "string" && raw.createRequestHash.trim().length > 0
      ? raw.createRequestHash.trim()
      : null;

  const game = {
    gameId: raw.gameId ?? "",
    joinCode:
      typeof raw.joinCode === "string" && raw.joinCode.trim().length > 0
        ? normalizeJoinCode(raw.joinCode)
        : buildJoinCodeForGameId(raw.gameId ?? ""),
    leagueId: raw.leagueId ?? "",
    seasonId: raw.seasonId ?? "",
    sessionId: raw.sessionId ?? "",
    status: raw.status ?? "scheduled",
    gameStartTs: raw.gameStartTs ?? "",
    thirdLengthMinutes: normalizeThirdLengthMinutes(raw.thirdLengthMinutes),
    thirds: normalizeThirdTimerSegments(raw.thirds),
    finishedAt: isValidTimestamp(raw.finishedAt) ? raw.finishedAt : null,
    result: normalizeGameResultPayload(raw.result),
  };

  return createRequestHash ? { ...game, createRequestHash } : game;
}

function normalizeNonNegativeInteger(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : 0;
}

function normalizePositiveInteger(value: unknown): number {
  return Number.isInteger(value) && (value as number) >= 1 ? (value as number) : 1;
}

function normalizeGameTeamPayload(data: unknown): Omit<GameTeamRecord, "createdAt" | "updatedAt"> {
  const raw = data as Partial<Omit<GameTeamRecord, "createdAt" | "updatedAt">>;

  return {
    gameId: raw.gameId ?? "",
    teamId: isTeamId(raw.teamId) ? raw.teamId : "red",
    name: typeof raw.name === "string" ? raw.name : "",
    color: typeof raw.color === "string" ? raw.color : null,
    scored: normalizeNonNegativeInteger(raw.scored),
    conceded: normalizeNonNegativeInteger(raw.conceded),
  };
}

function normalizeInviteEmail(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function normalizeLeagueInvitePayload(data: unknown): Omit<LeagueInviteRecord, "createdAt" | "updatedAt"> {
  const raw = data as Partial<Omit<LeagueInviteRecord, "createdAt" | "updatedAt">>;
  const acceptedByUserId =
    typeof raw.acceptedByUserId === "string" && raw.acceptedByUserId.trim().length > 0
      ? raw.acceptedByUserId
      : null;
  const kind = raw.kind === "share" || raw.kind === "email" ? raw.kind : "email";

  return {
    leagueId: raw.leagueId ?? "",
    inviteCode: typeof raw.inviteCode === "string" ? normalizeJoinCode(raw.inviteCode) : "",
    kind,
    role: "admin",
    email: normalizeInviteEmail(raw.email),
    createdByUserId: raw.createdByUserId ?? "",
    acceptedByUserId,
    acceptedAt: isValidTimestamp(raw.acceptedAt) ? raw.acceptedAt : null,
  };
}

function normalizeLeagueInvitePointerPayload(data: unknown): { leagueId: string; inviteCode: string } {
  const raw = data as Partial<{ leagueId: string; inviteCode: string }>;

  return {
    leagueId: raw.leagueId ?? "",
    inviteCode: typeof raw.inviteCode === "string" ? normalizeJoinCode(raw.inviteCode) : "",
  };
}

function normalizeGoalEventPayload(data: unknown): Omit<GoalEventRecord, "createdAt" | "updatedAt"> {
  const raw = data as Partial<Omit<GoalEventRecord, "createdAt" | "updatedAt">>;
  const third = normalizeThirdNumber(raw.third);
  const thirdMinute = normalizePositiveInteger(raw.thirdMinute);
  const gameMinute = normalizePositiveInteger(raw.gameMinute);
  const elapsedSeconds = normalizeNonNegativeInteger(raw.elapsedSeconds);

  return {
    gameId: raw.gameId ?? "",
    eventId: raw.eventId ?? "",
    third,
    thirdMinute,
    gameMinute,
    elapsedSeconds,
    stoppageMinute:
      Number.isInteger(raw.stoppageMinute) && (raw.stoppageMinute as number) >= 1
        ? (raw.stoppageMinute as number)
        : null,
    displayTime: raw.displayTime ?? String(gameMinute),
    scoringTeamId: isTeamId(raw.scoringTeamId) ? raw.scoringTeamId : null,
    concedingTeamId: isTeamId(raw.concedingTeamId) ? raw.concedingTeamId : "red",
    scorerPlayerId: raw.scorerPlayerId ?? "",
    assistPlayerIds: Array.isArray(raw.assistPlayerIds)
      ? raw.assistPlayerIds.filter((playerId): playerId is string => typeof playerId === "string")
      : [],
    ownGoal: raw.ownGoal ?? false,
  };
}

function normalizeGoalStatePayload(data: unknown): Omit<GoalStateRecord, "createdAt" | "updatedAt"> {
  const raw = data as Partial<Omit<GoalStateRecord, "createdAt" | "updatedAt">>;

  return {
    gameId: raw.gameId ?? "",
    latestEventId: typeof raw.latestEventId === "string" ? raw.latestEventId : null,
    latestGoalSk: typeof raw.latestGoalSk === "string" ? raw.latestGoalSk : null,
    revision: normalizeNonNegativeInteger(raw.revision),
  };
}

function normalizeGoalAuditSnapshot(data: unknown): GoalAuditSnapshotRecord | null {
  if (!data || typeof data !== "object") {
    return null;
  }

  const raw = data as Partial<GoalAuditSnapshotRecord>;
  const third = normalizeThirdNumber(raw.third);
  const thirdMinute = normalizePositiveInteger(raw.thirdMinute);
  const gameMinute = normalizePositiveInteger(raw.gameMinute);

  return {
    eventId: raw.eventId ?? "",
    third,
    thirdMinute,
    gameMinute,
    elapsedSeconds: normalizeNonNegativeInteger(raw.elapsedSeconds),
    stoppageMinute:
      Number.isInteger(raw.stoppageMinute) && (raw.stoppageMinute as number) >= 1
        ? (raw.stoppageMinute as number)
        : null,
    displayTime: typeof raw.displayTime === "string" ? raw.displayTime : String(gameMinute),
    scoringTeamId: isTeamId(raw.scoringTeamId) ? raw.scoringTeamId : null,
    concedingTeamId: isTeamId(raw.concedingTeamId) ? raw.concedingTeamId : "red",
    scorerPlayerId: raw.scorerPlayerId ?? "",
    assistPlayerIds: Array.isArray(raw.assistPlayerIds)
      ? raw.assistPlayerIds.filter((playerId): playerId is string => typeof playerId === "string")
      : [],
    ownGoal: typeof raw.ownGoal === "boolean" ? raw.ownGoal : false,
  };
}

const GOAL_AUDIT_ACTIONS = new Set<GoalAuditAction>([
  "goal_created",
  "goal_updated",
  "goal_deleted",
  "goal_undo_last",
]);

const GOAL_CORRECTION_ACTIONS = new Set<
  Extract<GoalAuditAction, "goal_updated" | "goal_deleted" | "goal_undo_last">
>(["goal_updated", "goal_deleted", "goal_undo_last"]);

function normalizeGoalAuditAction(action: unknown): GoalAuditAction {
  return typeof action === "string" && GOAL_AUDIT_ACTIONS.has(action as GoalAuditAction)
    ? (action as GoalAuditAction)
    : "goal_updated";
}

function normalizeGoalCorrectionAction(
  action: unknown,
): Extract<GoalAuditAction, "goal_updated" | "goal_deleted" | "goal_undo_last"> {
  return typeof action === "string" &&
    GOAL_CORRECTION_ACTIONS.has(
      action as Extract<GoalAuditAction, "goal_updated" | "goal_deleted" | "goal_undo_last">,
    )
    ? (action as Extract<GoalAuditAction, "goal_updated" | "goal_deleted" | "goal_undo_last">)
    : "goal_updated";
}

function normalizeGoalAuditPayload(data: unknown): Omit<GoalAuditRecord, "createdAt" | "updatedAt"> {
  const raw = data as Partial<Omit<GoalAuditRecord, "createdAt" | "updatedAt">>;

  return {
    auditId: raw.auditId ?? "",
    gameId: raw.gameId ?? "",
    eventId: raw.eventId ?? "",
    actorUserId: raw.actorUserId ?? "",
    action: normalizeGoalAuditAction(raw.action),
    before: normalizeGoalAuditSnapshot(raw.before),
    after: normalizeGoalAuditSnapshot(raw.after),
  };
}

function normalizeGoalCorrectionOperationPayload(
  data: unknown,
): Omit<GoalCorrectionOperationRecord, "createdAt" | "updatedAt"> {
  const raw = data as Partial<Omit<GoalCorrectionOperationRecord, "createdAt" | "updatedAt">>;

  return {
    gameId: raw.gameId ?? "",
    eventId: raw.eventId ?? "",
    operationId: raw.operationId ?? "",
    requestHash: raw.requestHash ?? "",
    action: normalizeGoalCorrectionAction(raw.action),
    result: raw.result as GoalCorrectionOperationRecord["result"],
  };
}

function isThirdStarted(game: Pick<GameRecord, "thirds">): boolean {
  return game.thirds.some((third) => third.startedAt !== null);
}

function areAllThirdsCompleted(game: Pick<GameRecord, "thirds">): boolean {
  return game.thirds.length === 3 && game.thirds.every((third) => third.startedAt && third.finishedAt);
}

function compareTeamIds(left: TeamId, right: TeamId): number {
  return TEAM_IDS.indexOf(left) - TEAM_IDS.indexOf(right);
}

function sortGameTeams<T extends { teamId: TeamId }>(teams: T[]): T[] {
  return [...teams].sort((left, right) => compareTeamIds(left.teamId, right.teamId));
}

function compareGameResultTeams(
  left: Pick<GameTeamRecord, "teamId" | "scored" | "conceded">,
  right: Pick<GameTeamRecord, "teamId" | "scored" | "conceded">,
): number {
  const concededSort = left.conceded - right.conceded;
  if (concededSort !== 0) {
    return concededSort;
  }

  const scoredSort = right.scored - left.scored;
  if (scoredSort !== 0) {
    return scoredSort;
  }

  return compareTeamIds(left.teamId, right.teamId);
}

function sameGameResultPosition(
  left: Pick<GameTeamRecord, "scored" | "conceded">,
  right: Pick<GameTeamRecord, "scored" | "conceded">,
): boolean {
  return left.conceded === right.conceded && left.scored === right.scored;
}

function buildGameResult(teams: GameTeamRecord[], computedAt: string): GameResult {
  const rankedTeams = [...teams].sort(compareGameResultTeams);
  const topTeam = rankedTeams[0] ?? null;
  const topTiedTeams = topTeam
    ? rankedTeams.filter((team) => sameGameResultPosition(team, topTeam))
    : [];
  const winnerTeamId = topTiedTeams.length === 1 ? topTiedTeams[0].teamId : null;

  let previousTeam: GameTeamRecord | null = null;
  let previousRank = 0;
  const resultTeams = rankedTeams.map((team, index) => {
    const rank =
      previousTeam && sameGameResultPosition(team, previousTeam)
        ? previousRank
        : index + 1;
    previousTeam = team;
    previousRank = rank;

    const outcome: GameResult["teams"][number]["outcome"] = winnerTeamId
      ? team.teamId === winnerTeamId
        ? "win"
        : "loss"
      : topTeam && sameGameResultPosition(team, topTeam)
        ? "draw"
        : "loss";

    return {
      teamId: team.teamId,
      name: team.name,
      color: team.color,
      scored: team.scored,
      conceded: team.conceded,
      rank,
      outcome,
    };
  });

  return {
    winnerTeamId,
    outcome: winnerTeamId ? "win" : "draw",
    comparator: "fewest_conceded_then_most_scored",
    computedAt,
    teams: resultTeams,
  };
}

function isCompleteGameResult(result: GameResult | null): result is GameResult {
  const resultTeams = result?.teams ?? [];
  const resultTeamIds = new Set(resultTeams.map((team) => team.teamId));
  return (
    resultTeams.length === TEAM_IDS.length &&
    TEAM_IDS.every((teamId) => resultTeamIds.has(teamId))
  );
}

function compareGoalEvents(
  left: Pick<GoalEventRecord, "third" | "gameMinute" | "elapsedSeconds" | "createdAt" | "eventId">,
  right: Pick<GoalEventRecord, "third" | "gameMinute" | "elapsedSeconds" | "createdAt" | "eventId">,
): number {
  const thirdSort = left.third - right.third;
  if (thirdSort !== 0) {
    return thirdSort;
  }

  const minuteSort = left.gameMinute - right.gameMinute;
  if (minuteSort !== 0) {
    return minuteSort;
  }

  const elapsedSort = left.elapsedSeconds - right.elapsedSeconds;
  if (elapsedSort !== 0) {
    return elapsedSort;
  }

  const createdAtSort = left.createdAt.localeCompare(right.createdAt);
  if (createdAtSort !== 0) {
    return createdAtSort;
  }

  return left.eventId.localeCompare(right.eventId);
}

function latestGoalEvent(goals: GoalEventRecord[]): GoalEventRecord | null {
  let latest: GoalEventRecord | null = null;
  for (const goal of goals) {
    if (!latest || compareGoalEvents(latest, goal) < 0) {
      latest = goal;
    }
  }

  return latest;
}

function goalAuditSnapshot(goal: GoalEventRecord): GoalAuditSnapshotRecord {
  return {
    eventId: goal.eventId,
    third: goal.third,
    thirdMinute: goal.thirdMinute,
    gameMinute: goal.gameMinute,
    elapsedSeconds: goal.elapsedSeconds,
    stoppageMinute: goal.stoppageMinute,
    displayTime: goal.displayTime,
    scoringTeamId: goal.scoringTeamId,
    concedingTeamId: goal.concedingTeamId,
    scorerPlayerId: goal.scorerPlayerId,
    assistPlayerIds: goal.assistPlayerIds,
    ownGoal: goal.ownGoal,
  };
}

function isConditionalWriteFailure(error: unknown): boolean {
  const awsError = error as {
    name?: string;
    CancellationReasons?: Array<{ Code?: string }>;
    cancellationReasons?: Array<{ Code?: string }>;
  };

  if (awsError.name === "ConditionalCheckFailedException") {
    return true;
  }

  if (awsError.name !== "TransactionCanceledException") {
    return false;
  }

  const reasons = transactionCancellationReasons(error);
  let hasConditionalFailure = false;
  for (const reason of reasons) {
    if (!reason.Code || reason.Code === "None") {
      continue;
    }
    if (isConditionalCancellationCode(reason.Code)) {
      hasConditionalFailure = true;
      continue;
    }
    return false;
  }

  return hasConditionalFailure;
}

function transactionCancellationReasons(error: unknown): Array<{ Code?: string }> {
  const awsError = error as {
    CancellationReasons?: Array<{ Code?: string }>;
    cancellationReasons?: Array<{ Code?: string }>;
  };
  return awsError.CancellationReasons ?? awsError.cancellationReasons ?? [];
}

function isConditionalCancellationCode(code: string | undefined): boolean {
  return code === "ConditionalCheckFailed" || code === "ConditionalCheckFailedException";
}

function transactionCancellationCode(error: unknown, index: number): string | null {
  const reason = transactionCancellationReasons(error)[index];
  return typeof reason?.Code === "string" ? reason.Code : null;
}

function readString(value: AttributeValue | undefined, field: string): string {
  if (!value || value.S === undefined) {
    throw new Error(`Missing string attribute \`${field}\`.`);
  }

  return value.S;
}

function buildItem<T>(
  pk: string,
  sk: string,
  entityType: EntityType,
  payload: T,
  now: string,
): Item {
  return buildItemWithTimestamps(pk, sk, entityType, payload, now, now);
}

function buildItemWithTimestamps<T>(
  pk: string,
  sk: string,
  entityType: EntityType,
  payload: T,
  createdAt: string,
  updatedAt: string,
): Item {
  return {
    pk: { S: pk },
    sk: { S: sk },
    entityType: { S: entityType },
    createdAt: { S: createdAt },
    updatedAt: { S: updatedAt },
    data: { S: JSON.stringify(payload) },
  };
}

function parseStoredEntity<T>(item: Item): StoredEntity<T> {
  const rawData = readString(item.data, "data");
  return {
    pk: readString(item.pk, "pk"),
    sk: readString(item.sk, "sk"),
    entityType: readString(item.entityType, "entityType") as EntityType,
    createdAt: readString(item.createdAt, "createdAt"),
    updatedAt: readString(item.updatedAt, "updatedAt"),
    rawData,
    data: JSON.parse(rawData) as T,
  };
}

function withTimestamps<T extends object>(
  payload: T,
  createdAt: string,
  updatedAt: string,
): T & { createdAt: string; updatedAt: string } {
  return {
    ...payload,
    createdAt,
    updatedAt,
  };
}

export class ThreeFcRepository {
  private ownedJoinService(): OwnedPlayerJoinService {
    return new OwnedPlayerJoinService(this.client, this.tableName, () => this.clock.now(),
      (game, id, nickname, now) => this.planPlayerMembership(game, id, nickname, now), process.env.PLAYER_RETURNING_JOIN_ENABLED === "true");
  }
  listOwnedJoinPlayers(input: Parameters<OwnedPlayerJoinService["list"]>[0]) { return this.ownedJoinService().list(input); }
  joinOwnedPlayer(input: Parameters<OwnedPlayerJoinService["join"]>[0]) { return this.ownedJoinService().join(input); }
  private consolidationService(): PlayerConsolidationService {
    return new PlayerConsolidationService(this.client, this.tableName, () => this.clock.now(),
      process.env.PLAYER_CONSOLIDATION_ENABLED === "true");
  }

  previewPlayerConsolidation(input: Parameters<PlayerConsolidationService["preview"]>[0]) {
    return this.consolidationService().preview(input);
  }
  getPlayerConsolidation(input: Parameters<PlayerConsolidationService["get"]>[0]) {
    return this.consolidationService().get(input);
  }
  decidePlayerConsolidation(input: Parameters<PlayerConsolidationService["decide"]>[0]) {
    return this.consolidationService().decide(input);
  }
  commitPlayerConsolidation(input: Parameters<PlayerConsolidationService["commit"]>[0]) {
    return this.consolidationService().commit(input);
  }
  private readonly identities: PlayerIdentityPlanner;
  constructor(
    private readonly client: DynamoCommandClient,
    private readonly tableName: string,
    private readonly clock: Clock = new DefaultClock(),
    private readonly playerClaimMode: PlayerClaimMode = parsePlayerClaimMode(process.env.PLAYER_CLAIM_MODE),
  ) { this.identities = new PlayerIdentityPlanner(client, tableName); }

  private async planPlayerMembership(game: Pick<GameRecord, "gameId" | "leagueId" | "seasonId" | "gameStartTs">,
    requestedPlayerId: string, nickname: string, now: string): Promise<{
      playerId: string; identity: ResolvedPlayerIdentity; actions: TransactWriteItem[];
    }> {
    const control = await this.identities.readControl();
    const fence = this.identities.writableControl(control);
    const identity = await this.identities.resolve(requestedPlayerId, nickname);
    const original = await this.identities.registeredOriginal(identity, game.gameId);
    const playerId = original ?? identity.root.value.playerId;
    if (Buffer.byteLength(gamePlayerSk(playerId)) > 1024) throw new PlayerIdentityError("player_registration_key_too_large", 400,
      "This legacy player profile cannot be added to a game. Ask the organiser for help.");
    const requireExisting = control.value.mode === "fenced" && original === null &&
      await this.getPlayer(identity.root.value.playerId, { consistentRead: true }) !== null;
    return { playerId, identity, actions: [fence, ...this.identities.planRevision(identity, now),
      await this.identities.liveScope("game", [game.gameId]), await this.identities.liveScope("league", [game.leagueId]),
      await this.identities.liveScope("season", [game.leagueId, game.seasonId]),
      ...await this.identities.planDirectory(identity, game.leagueId, now, { ...game, registeredPlayerId: playerId }, requireExisting)] };
  }

  async createLeague(input: CreateLeagueInput): Promise<LeagueRecord> {
    requireNonEmpty("leagueId", input.leagueId);
    requireNonEmpty("name", input.name);
    requireNonEmpty("createdByUserId", input.createdByUserId);

    const now = this.clock.now();
    const payload = {
      leagueId: input.leagueId,
      name: input.name,
      slug: input.slug ?? null,
      createdByUserId: input.createdByUserId,
    };

    const control = await this.identities.readControl();
    const fence = this.identities.writableControl(control);
    const existing = await this.getEntity(leaguePk(input.leagueId), metadataSk(), { consistentRead: true });
    const conflict = () => new PlayerIdentityError("league_exists", 409, "This league already exists. Choose a different league ID.");
    if (existing) {
      const data = existing.data as typeof payload;
      const acl = await this.getEntity(leaguePk(input.leagueId), aclSk(input.createdByUserId), { consistentRead: true });
      const access = acl?.data as LeagueAclRecord | undefined;
      if (existing.entityType !== ENTITY_TYPE.league || !data || Object.entries(payload).some(([key, value]) => data[key as keyof typeof payload] !== value) ||
          acl?.entityType !== ENTITY_TYPE.acl || access?.leagueId !== input.leagueId || access?.userId !== input.createdByUserId || access?.role !== "admin") throw conflict();
      // A lost-response retry may read the original result, never recreate a
      // revoked ACL or overwrite an existing league owned by someone else.
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: [fence,
        this.buildConditionalCheckFromStoredEntity(existing), this.buildConditionalCheckFromStoredEntity(acl)] }));
      return withTimestamps(data, existing.createdAt, existing.updatedAt);
    }
    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction([
        this.identities.planStructureChange(control, now), await this.identities.liveScope("league", [input.leagueId]),
        { Put: { TableName: this.tableName, Item: buildItem(leaguePk(input.leagueId), metadataSk(), ENTITY_TYPE.league, payload, now),
          ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
        { Put: { TableName: this.tableName, Item: buildItem(leaguePk(input.leagueId), aclSk(input.createdByUserId), ENTITY_TYPE.acl,
          { leagueId: input.leagueId, userId: input.createdByUserId, role: "admin", grantedByUserId: input.createdByUserId }, now),
          ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
      ]) }));
    } catch (error) {
      if (isConditionalWriteFailure(error)) throw conflict();
      throw error;
    }
    return withTimestamps(payload, now, now);
  }

  async getLeague(leagueId: string): Promise<LeagueRecord | null> {
    requireNonEmpty("leagueId", leagueId);
    const item = await this.getEntity(leaguePk(leagueId), metadataSk());

    if (!item || item.entityType !== ENTITY_TYPE.league) {
      return null;
    }

    return withTimestamps(item.data as Omit<LeagueRecord, "createdAt" | "updatedAt">, item.createdAt, item.updatedAt);
  }

  async listLeaguesForUser(userId: string): Promise<LeagueRecord[]> {
    requireNonEmpty("userId", userId);

    const leagueIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: ScanCommandOutput["LastEvaluatedKey"];
    do {
      const scanResult = (await this.client.send(new ScanCommand({
        TableName: this.tableName,
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }))) as ScanCommandOutput;
      for (const item of scanResult.Items ?? []) {
        if (item.entityType?.S !== ENTITY_TYPE.acl) {
          continue;
        }

        if (!item.data || item.data.S === undefined) {
          // Skip non-repository ACL-shaped items that do not store JSON payloads.
          continue;
        }

        let data: unknown;
        try {
          data = JSON.parse(item.data.S);
        } catch {
          continue;
        }

        if (
          typeof data === "object" &&
          data !== null &&
          typeof (data as { leagueId?: unknown }).leagueId === "string" &&
          typeof (data as { userId?: unknown }).userId === "string" &&
          (data as { userId: string }).userId === userId
        ) {
          leagueIds.add((data as { leagueId: string }).leagueId);
        }
      }
      const next = scanResult.LastEvaluatedKey;
      if (!next || Object.keys(next).length === 0) break;
      if (typeof next.pk?.S !== "string" || !next.pk.S || typeof next.sk?.S !== "string" || !next.sk.S) {
        throw new Error("League discovery returned an invalid cursor.");
      }
      // Scan order is not lexical; detect repeated physical keys without
      // assuming ordering or depending on the SDK object's property order.
      const cursorId = JSON.stringify([next.pk.S, next.sk.S]);
      if (seenCursors.has(cursorId)) throw new Error("League discovery cursor did not advance.");
      seenCursors.add(cursorId);
      cursor = next;
    } while (cursor);

    const leagues = await Promise.all([...leagueIds].map((leagueId) => this.getLeague(leagueId)));
    return leagues
      .filter((league): league is LeagueRecord => league !== null)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async createSeason(input: CreateSeasonInput): Promise<SeasonRecord> {
    requireNonEmpty("leagueId", input.leagueId);
    requireNonEmpty("seasonId", input.seasonId);
    requireNonEmpty("name", input.name);

    const now = this.clock.now();
    const payload = {
      leagueId: input.leagueId,
      seasonId: input.seasonId,
      name: input.name,
      slug: input.slug ?? null,
      startsOn: input.startsOn ?? null,
      endsOn: input.endsOn ?? null,
    };

    const control = await this.identities.readControl();
    const structure = this.identities.planStructureChange(control, now);
    const existing = await this.getEntity(leaguePk(input.leagueId), seasonSk(input.seasonId), { consistentRead: true });
    if (existing) {
      const data = existing.data as typeof payload;
      if (existing.entityType !== ENTITY_TYPE.season || !data ||
          Object.entries(payload).some(([key, value]) => data[key as keyof typeof payload] !== value)) {
        throw new PlayerIdentityError("season_exists", 409, "The season list changed. Refresh before trying again.");
      }
      // Default-team setup happens after metadata creation. An exact retry must
      // be able to complete it without replacing the original season or dates.
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: [
        this.identities.writableControl(control), this.buildConditionalCheckFromStoredEntity(existing),
        await this.identities.liveScope("league", [input.leagueId]),
        await this.identities.liveScope("season", [input.leagueId, input.seasonId]),
      ] }));
      return withTimestamps(data, existing.createdAt, existing.updatedAt);
    }
    const legacy = await this.getEntity(seasonPk(input.seasonId), metadataSk(), { consistentRead: true });
    // Season IDs are league-scoped. Keep the first legacy route owner rather
    // than retargeting its metadata when another league uses the same season ID.
    const legacyAction: TransactWriteItem = legacy ? this.buildConditionalCheckFromStoredEntity(legacy) :
      { Put: { TableName: this.tableName, Item: buildItem(seasonPk(input.seasonId), metadataSk(), ENTITY_TYPE.season, payload, now),
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } };
    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction([
        structure, await this.identities.liveScope("league", [input.leagueId]),
        await this.identities.liveScope("season", [input.leagueId, input.seasonId]),
        { Put: { TableName: this.tableName, Item: buildItem(leaguePk(input.leagueId), seasonSk(input.seasonId), ENTITY_TYPE.season, payload, now),
          ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } }, legacyAction,
      ]) }));
    } catch (error) {
      if (isConditionalWriteFailure(error)) throw new PlayerIdentityError("season_exists", 409, "The season list changed. Refresh before trying again.");
      throw error;
    }
    return withTimestamps(payload, now, now);
  }

  async getSeason(seasonId: string): Promise<SeasonRecord | null> {
    requireNonEmpty("seasonId", seasonId);
    const item = await this.getEntity(seasonPk(seasonId), metadataSk());

    if (!item || item.entityType !== ENTITY_TYPE.season) {
      return null;
    }

    return withTimestamps(
      item.data as Omit<SeasonRecord, "createdAt" | "updatedAt">,
      item.createdAt,
      item.updatedAt,
    );
  }

  async getSeasonForLeague(
    leagueId: string,
    seasonId: string,
    options: { consistentRead?: boolean } = {},
  ): Promise<SeasonRecord | null> {
    requireNonEmpty("leagueId", leagueId);
    requireNonEmpty("seasonId", seasonId);
    const item = await this.getEntity(leaguePk(leagueId), seasonSk(seasonId), options);

    if (!item || item.entityType !== ENTITY_TYPE.season) {
      return null;
    }

    return withTimestamps(
      item.data as Omit<SeasonRecord, "createdAt" | "updatedAt">,
      item.createdAt,
      item.updatedAt,
    );
  }

  async listSeasonsForLeague(
    leagueId: string,
    options: { consistentRead?: boolean } = {},
  ): Promise<SeasonRecord[]> {
    requireNonEmpty("leagueId", leagueId);
    const items = await this.queryByPrefix(leaguePk(leagueId), "SEASON#", options);

    return items
      .filter((item) => item.entityType === ENTITY_TYPE.season)
      .map((item) =>
        withTimestamps(
          item.data as Omit<SeasonRecord, "createdAt" | "updatedAt">,
          item.createdAt,
          item.updatedAt,
        ),
      );
  }

  async createTeam(input: CreateTeamInput): Promise<TeamRecord> {
    if (input.leagueId !== undefined) {
      requireNonEmpty("leagueId", input.leagueId);
    }
    requireNonEmpty("seasonId", input.seasonId);
    requireNonEmpty("name", input.name);

    const now = this.clock.now();
    const teamPartitionKey = input.leagueId ? leaguePk(input.leagueId) : seasonPk(input.seasonId);
    const teamSortKey = input.leagueId
      ? scopedSeasonTeamSk(input.seasonId, input.teamId)
      : teamSk(input.teamId);
    const existing = await this.getEntity(teamPartitionKey, teamSortKey, {
      consistentRead: input.createOnly,
    });
    const existingTeam = existing?.entityType === ENTITY_TYPE.team ? existing : null;
    const existingPayload = existingTeam
      ? (existingTeam.data as Omit<TeamRecord, "createdAt" | "updatedAt">)
      : null;
    if (input.createOnly && existingTeam && existingPayload) {
      return withTimestamps(existingPayload, existingTeam.createdAt, existingTeam.updatedAt);
    }
    const legacySeasonItem = input.leagueId
      ? null
      : await this.getEntity(seasonPk(input.seasonId), metadataSk(), { consistentRead: true });
    const legacySeason =
      legacySeasonItem?.entityType === ENTITY_TYPE.season
        ? (legacySeasonItem.data as Partial<SeasonRecord>)
        : null;

    const payload = {
      ...(input.leagueId
        ? { leagueId: input.leagueId }
        : legacySeason?.leagueId
          ? { leagueId: legacySeason.leagueId }
          : {}),
      seasonId: input.seasonId,
      teamId: input.teamId,
      name: input.name,
      color: input.color ?? null,
    };

    if (input.leagueId) {
      const seasonItem = await this.getEntity(leaguePk(input.leagueId), seasonSk(input.seasonId), {
        consistentRead: true,
      });
      if (!seasonItem || seasonItem.entityType !== ENTITY_TYPE.season) {
        throw new GameMutationStateError(
          "game_state_changed",
          `Season ${input.seasonId} changed before the team could be created. Reload and try again.`,
        );
      }

      const transactionItems: TransactWriteItem[] = [
        {
          Put: {
            TableName: this.tableName,
            Item: buildItemWithTimestamps(
              teamPartitionKey,
              teamSortKey,
              ENTITY_TYPE.team,
              payload,
              now,
              now,
            ),
            ...(input.createOnly
              ? {
                  ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                }
              : {}),
          },
        },
        this.buildConditionalPutFromStoredEntity(seasonItem, now),
      ];

      try {
        await this.client.send(
          new TransactWriteItemsCommand({
            TransactItems: transactionItems,
          }),
        );
      } catch (error) {
        if (isConditionalWriteFailure(error)) {
          if (input.createOnly) {
            const concurrent = await this.getEntity(teamPartitionKey, teamSortKey, {
              consistentRead: true,
            });
            if (concurrent?.entityType === ENTITY_TYPE.team) {
              return withTimestamps(
                concurrent.data as Omit<TeamRecord, "createdAt" | "updatedAt">,
                concurrent.createdAt,
                concurrent.updatedAt,
              );
            }
          }

          throw new GameMutationStateError(
            "game_state_changed",
            `Season ${input.seasonId} changed before the team could be created. Reload and try again.`,
          );
        }

        throw error;
      }

      return withTimestamps(payload, now, now);
    }

    if (!legacySeasonItem || legacySeasonItem.entityType !== ENTITY_TYPE.season) {
      throw new GameMutationStateError(
        "game_state_changed",
        `Season ${input.seasonId} changed before the team could be created. Reload and try again.`,
      );
    }

    const teamPut: TransactWriteItem = {
      Put: {
        TableName: this.tableName,
        Item: buildItemWithTimestamps(
          teamPartitionKey,
          teamSortKey,
          ENTITY_TYPE.team,
          payload,
          now,
          now,
        ),
        ...(input.createOnly
          ? {
              ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            }
          : {}),
      },
    };

    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            this.buildConditionalCheckFromStoredEntity(legacySeasonItem),
            teamPut,
          ],
        }),
      );
    } catch (error) {
      if (!isConditionalWriteFailure(error)) {
        throw error;
      }

      if (input.createOnly) {
        const [currentSeason, concurrent] = await Promise.all([
          this.getEntity(seasonPk(input.seasonId), metadataSk(), { consistentRead: true }),
          this.getEntity(teamPartitionKey, teamSortKey, { consistentRead: true }),
        ]);
        if (
          currentSeason?.entityType === ENTITY_TYPE.season &&
          currentSeason.updatedAt === legacySeasonItem.updatedAt &&
          currentSeason.rawData === legacySeasonItem.rawData &&
          concurrent?.entityType === ENTITY_TYPE.team
        ) {
          return withTimestamps(
            concurrent.data as Omit<TeamRecord, "createdAt" | "updatedAt">,
            concurrent.createdAt,
            concurrent.updatedAt,
          );
        }
      }

      throw new GameMutationStateError(
        "game_state_changed",
        `Season ${input.seasonId} changed before the team could be created. Reload and try again.`,
      );
    }

    return withTimestamps(payload, now, now);
  }

  async listTeamsForSeason(
    seasonId: string,
    options: { consistentRead?: boolean; leagueId?: string } = {},
  ): Promise<TeamRecord[]> {
    requireNonEmpty("seasonId", seasonId);
    if (options.leagueId !== undefined) {
      requireNonEmpty("leagueId", options.leagueId);
    }

    const scopedItems = options.leagueId
      ? await this.queryByPrefix(leaguePk(options.leagueId), `SEASON#${seasonId}#TEAM#`, options)
      : [];
    const legacyItems = options.leagueId
      ? await this.readOwnedLegacySeasonTeamTemplateItems(seasonId, options.leagueId)
      : await this.queryByPrefix(seasonPk(seasonId), "TEAM#", options);

    const teamsById = new Map<TeamId, TeamRecord>();
    for (const team of legacyItems
      .filter((item) => item.entityType === ENTITY_TYPE.team)
      .map((item) =>
        withTimestamps(
          item.data as Omit<TeamRecord, "createdAt" | "updatedAt">,
          item.createdAt,
          item.updatedAt,
        ),
      )) {
      if (shouldUseTeamCandidate(teamsById.get(team.teamId), team)) {
        teamsById.set(team.teamId, team);
      }
    }
    for (const team of scopedItems
      .filter((item) => item.entityType === ENTITY_TYPE.team)
      .map((item) =>
        withTimestamps(
          item.data as Omit<TeamRecord, "createdAt" | "updatedAt">,
          item.createdAt,
          item.updatedAt,
        ),
      )) {
      if (shouldUseTeamCandidate(teamsById.get(team.teamId), team)) {
        teamsById.set(team.teamId, team);
      }
    }

    return [...teamsById.values()];
  }

  async createGameTeamOverride(input: CreateGameTeamInput): Promise<GameTeamRecord> {
    requireNonEmpty("gameId", input.gameId);
    requireNonEmpty("name", input.name);

    const { item: gameItem, game } = await this.readGameForMutation({
      gameId: input.gameId,
      allowFinished: input.allowFinished,
      finishedMessage: `Game ${input.gameId} is finished. Team overrides are locked after finish.`,
      changedMessage: `Game ${input.gameId} changed before the team override could be saved. Reload and try again.`,
    });
    const now = this.clock.now();
    const existing = await this.getEntity(gamePk(input.gameId), teamSk(input.teamId), {
      consistentRead: input.createOnly,
    });
    const existingTeam = existing?.entityType === ENTITY_TYPE.gameTeam ? existing : null;
    const existingPayload = existingTeam ? normalizeGameTeamPayload(existingTeam.data) : null;
    if (input.createOnly && existingTeam && existingPayload) {
      return withTimestamps(existingPayload, existingTeam.createdAt, existingTeam.updatedAt);
    }

    const payload = {
      gameId: input.gameId,
      teamId: input.teamId,
      name: input.name,
      color: input.color ?? null,
      scored: existingPayload?.scored ?? 0,
      conceded: existingPayload?.conceded ?? 0,
    };

    if (game.status === "finished") {
      const { teams, teamStatesById } = await this.readGoalTeamStates(input.gameId, {
        consistentRead: true,
      });
      const originalTeamState = teamStatesById.get(input.teamId);
      if (!originalTeamState && !input.createOnly) {
        throw new GameMutationStateError(
          "game_state_changed",
          `Game ${input.gameId} changed before the team override could be saved. Reload and try again.`,
        );
      }

      const nextTeams = sortGameTeams(
        originalTeamState
          ? teams.map((team) =>
              team.teamId === input.teamId
                ? {
                    ...team,
                    name: payload.name,
                    color: payload.color,
                    updatedAt: now,
                  }
                : team,
            )
          : [
              ...teams,
              {
                ...payload,
                createdAt: now,
                updatedAt: now,
              },
            ],
      );
      const hasAllResultTeams = TEAM_IDS.every((teamId) =>
        nextTeams.some((team) => team.teamId === teamId),
      );
      const updatedGame = {
        ...game,
        finishedAt: hasAllResultTeams ? game.finishedAt ?? now : game.finishedAt,
        result: hasAllResultTeams ? buildGameResult(nextTeams, now) : null,
      };
      const existingTeamPutItems = this.buildTeamPutTransactionItems(
        nextTeams.filter((team) => teamStatesById.has(team.teamId)),
        teamStatesById,
        now,
      );
      const missingTeamPutItems = originalTeamState
        ? []
        : [
            {
              Put: {
                TableName: this.tableName,
                Item: buildItemWithTimestamps(
                  gamePk(input.gameId),
                  teamSk(input.teamId),
                  ENTITY_TYPE.gameTeam,
                  payload,
                  now,
                  now,
                ),
                ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
          ];

      try {
        await this.client.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              this.buildGamePutTransactionItem({
                game: updatedGame,
                stored: gameItem,
                now,
              }),
              ...existingTeamPutItems,
              ...missingTeamPutItems,
            ],
          }),
        );
      } catch (error) {
        if (isConditionalWriteFailure(error)) {
          throw new GameMutationStateError(
            "game_state_changed",
            `Game ${input.gameId} changed before the team override could be saved. Reload and try again.`,
          );
        }

        throw error;
      }

      const updatedTeam = nextTeams.find((team) => team.teamId === input.teamId);
      if (!updatedTeam) {
        throw new GameMutationStateError(
          "game_state_changed",
          `Game ${input.gameId} changed before the team override could be saved. Reload and try again.`,
        );
      }

      return updatedTeam;
    }

    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            this.buildGameConditionCheck(input.gameId, gameItem),
            {
              Put: {
                TableName: this.tableName,
                Item: buildItemWithTimestamps(
                  gamePk(input.gameId),
                  teamSk(input.teamId),
                  ENTITY_TYPE.gameTeam,
                  payload,
                  existingTeam?.createdAt ?? now,
                  now,
                ),
                ...(input.createOnly
                  ? { ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" }
                  : {}),
              },
            },
          ],
        }),
      );
    } catch (error) {
      if (isConditionalWriteFailure(error)) {
        if (input.createOnly) {
          const concurrent = await this.getEntity(gamePk(input.gameId), teamSk(input.teamId), {
            consistentRead: true,
          });
          if (concurrent?.entityType === ENTITY_TYPE.gameTeam) {
            return withTimestamps(
              normalizeGameTeamPayload(concurrent.data),
              concurrent.createdAt,
              concurrent.updatedAt,
            );
          }
        }

        throw new GameMutationStateError(
          "game_state_changed",
          `Game ${input.gameId} changed before the team override could be saved. Reload and try again.`,
        );
      }

      throw error;
    }
    return withTimestamps(payload, existingTeam?.createdAt ?? now, now);
  }

  async listTeamsForGame(
    gameId: string,
    options: { consistentRead?: boolean } = {},
  ): Promise<GameTeamRecord[]> {
    requireNonEmpty("gameId", gameId);
    const items = await this.queryByPrefix(gamePk(gameId), "TEAM#", options);

    const teams = items
      .filter((item) => item.entityType === ENTITY_TYPE.gameTeam)
      .map((item) =>
        withTimestamps(
          normalizeGameTeamPayload(item.data),
          item.createdAt,
          item.updatedAt,
        ),
      );

    return sortGameTeams(teams);
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    if (input.leagueId !== undefined) {
      requireNonEmpty("leagueId", input.leagueId);
    }
    requireNonEmpty("seasonId", input.seasonId);
    requireNonEmpty("sessionId", input.sessionId);
    requireNonEmpty("sessionDate", input.sessionDate);

    const now = this.clock.now();
    const legacySeasonItem = input.leagueId
      ? null
      : await this.getEntity(seasonPk(input.seasonId), metadataSk(), { consistentRead: true });
    const legacySeason =
      legacySeasonItem?.entityType === ENTITY_TYPE.season
        ? (legacySeasonItem.data as Partial<SeasonRecord>)
        : null;
    const payload = {
      ...(input.leagueId
        ? { leagueId: input.leagueId }
        : legacySeason?.leagueId
          ? { leagueId: legacySeason.leagueId }
          : {}),
      seasonId: input.seasonId,
      sessionId: input.sessionId,
      sessionDate: input.sessionDate,
    };
    const identityChecks = [this.identities.planStructureChange(await this.identities.readControl(), now),
      ...(payload.leagueId ? [await this.identities.liveScope("league", [payload.leagueId]),
        await this.identities.liveScope("season", [payload.leagueId, input.seasonId])] : [])];

    if (input.leagueId) {
      const [seasonItem, globalSeasonItem, legacySeasonSessionItem, legacySessionMetadataItem] =
        await Promise.all([
          this.getEntity(leaguePk(input.leagueId), seasonSk(input.seasonId), {
            consistentRead: true,
          }),
          this.getEntity(seasonPk(input.seasonId), metadataSk(), {
            consistentRead: true,
          }),
          this.getEntity(seasonPk(input.seasonId), sessionSk(input.sessionId), {
            consistentRead: true,
          }),
          this.getEntity(sessionPk(input.sessionId), metadataSk(), {
            consistentRead: true,
          }),
        ]);
      if (!seasonItem || seasonItem.entityType !== ENTITY_TYPE.season) {
        throw new GameMutationStateError(
          "game_state_changed",
          `Season ${input.seasonId} changed before the session could be created. Reload and try again.`,
        );
      }
      const expectedLegacySession = {
        leagueId: input.leagueId,
        seasonId: input.seasonId,
        sessionId: input.sessionId,
      };
      const canWriteLegacyCompatibility = this.isMatchingSeasonEntity(globalSeasonItem, {
        leagueId: input.leagueId,
        seasonId: input.seasonId,
      });
      const hasForeignLegacySession = [legacySeasonSessionItem, legacySessionMetadataItem].some(
        (item) =>
          item &&
          !this.isMatchingSessionEntity(item, expectedLegacySession) &&
          !(
            canWriteLegacyCompatibility &&
            this.isMatchingLegacySessionEntityWithoutLeague(item, expectedLegacySession)
          ),
      );
      const legacyCompatibilityWrites = hasForeignLegacySession || !canWriteLegacyCompatibility
        ? []
        : [
            this.buildConditionalCheckFromStoredEntity(globalSeasonItem),
            this.buildLegacySessionCompatibilityPut({
              pk: seasonPk(input.seasonId),
              sk: sessionSk(input.sessionId),
              payload,
              existing: legacySeasonSessionItem,
              expected: expectedLegacySession,
              allowLegacyWithoutLeague: true,
              now,
            }),
            this.buildLegacySessionCompatibilityPut({
              pk: sessionPk(input.sessionId),
              sk: metadataSk(),
              payload,
              existing: legacySessionMetadataItem,
              expected: expectedLegacySession,
              allowLegacyWithoutLeague: true,
              now,
            }),
          ].filter((item): item is TransactWriteItem => item !== null);

      try {
        await this.client.send(
          new TransactWriteItemsCommand({
            TransactItems: [
              {
                Put: {
                  TableName: this.tableName,
                  Item: buildItem(
                    leaguePk(input.leagueId),
                    scopedSeasonSessionSk(input.seasonId, input.sessionId),
                    ENTITY_TYPE.session,
                    payload,
                    now,
                  ),
                },
              },
              ...legacyCompatibilityWrites,
              ...identityChecks,
              {
                Put: {
                  TableName: this.tableName,
                  Item: buildItemWithTimestamps(
                    leaguePk(input.leagueId),
                    seasonSk(input.seasonId),
                    ENTITY_TYPE.season,
                    seasonItem.data,
                    seasonItem.createdAt,
                    now,
                  ),
                  ConditionExpression: "#updatedAt = :expectedSeasonUpdatedAt AND #data = :expectedSeasonData",
                  ExpressionAttributeNames: {
                    "#updatedAt": "updatedAt",
                    "#data": "data",
                  },
                  ExpressionAttributeValues: {
                    ":expectedSeasonUpdatedAt": { S: seasonItem.updatedAt },
                    ":expectedSeasonData": { S: seasonItem.rawData },
                  },
                },
              },
            ],
          }),
        );
      } catch (error) {
        if (isConditionalWriteFailure(error)) {
          throw new GameMutationStateError(
            "game_state_changed",
            `Season ${input.seasonId} changed before the session could be created. Reload and try again.`,
          );
        }

        throw error;
      }
      return withTimestamps(payload, now, now);
    }

    await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction([
      ...identityChecks,
      { Put: { TableName: this.tableName, Item: buildItem(seasonPk(input.seasonId), sessionSk(input.sessionId), ENTITY_TYPE.session, payload, now) } },
      { Put: { TableName: this.tableName, Item: buildItem(sessionPk(input.sessionId), metadataSk(), ENTITY_TYPE.session, payload, now) } },
    ]) }));
    return withTimestamps(payload, now, now);
  }

  async getSession(sessionId: string): Promise<SessionRecord | null> {
    requireNonEmpty("sessionId", sessionId);
    const item = await this.getEntity(sessionPk(sessionId), metadataSk());

    if (!item || item.entityType !== ENTITY_TYPE.session) {
      return null;
    }

    return withTimestamps(
      item.data as Omit<SessionRecord, "createdAt" | "updatedAt">,
      item.createdAt,
      item.updatedAt,
    );
  }

  async getSessionForSeason(
    seasonId: string,
    sessionId: string,
    options: { leagueId?: string } = {},
  ): Promise<SessionRecord | null> {
    requireNonEmpty("seasonId", seasonId);
    requireNonEmpty("sessionId", sessionId);
    if (options.leagueId !== undefined) {
      requireNonEmpty("leagueId", options.leagueId);
      const item = await this.getEntity(
        leaguePk(options.leagueId),
        scopedSeasonSessionSk(seasonId, sessionId),
        { consistentRead: true },
      );

      if (!item || item.entityType !== ENTITY_TYPE.session) {
        return null;
      }

      return withTimestamps(
        item.data as Omit<SessionRecord, "createdAt" | "updatedAt">,
        item.createdAt,
        item.updatedAt,
      );
    }

    const session = await this.getSession(sessionId);
    return session?.seasonId === seasonId ? session : null;
  }

  async listSessionsForSeason(
    seasonId: string,
    options: { leagueId?: string; consistentRead?: boolean } = {},
  ): Promise<SessionRecord[]> {
    requireNonEmpty("seasonId", seasonId);
    if (options.leagueId !== undefined) {
      requireNonEmpty("leagueId", options.leagueId);
    }

    const items = options.leagueId
      ? await this.queryByPrefix(
          leaguePk(options.leagueId),
          `SEASON#${seasonId}#SESSION#`,
          { consistentRead: options.consistentRead },
        )
      : await this.queryByPrefix(seasonPk(seasonId), "SESSION#", {
          consistentRead: options.consistentRead,
        });

    return items
      .filter((item) => item.entityType === ENTITY_TYPE.session)
      .map((item) =>
        withTimestamps(
          item.data as Omit<SessionRecord, "createdAt" | "updatedAt">,
          item.createdAt,
          item.updatedAt,
        ),
      );
  }

  async createGame(input: CreateGameInput): Promise<GameRecord> {
    requireNonEmpty("gameId", input.gameId);
    requireNonEmpty("leagueId", input.leagueId);
    requireNonEmpty("seasonId", input.seasonId);
    requireNonEmpty("sessionId", input.sessionId);
    requireNonEmpty("gameStartTs", input.gameStartTs);

    if (input.status === "finished") {
      throw new GameTimerTransitionError(
        "invalid_status_transition",
        "Games cannot be created directly as finished. Finish a completed live game instead.",
      );
    }

    const now = this.clock.now();
    const customJoinCode = input.joinCode?.trim()
      ? normalizeCustomJoinCode(input.joinCode)
      : null;
    const linkSession = input.linkSession === true;

    for (let attempt = 0; attempt < (customJoinCode ? 1 : JOIN_CODE_GENERATION_ATTEMPTS); attempt += 1) {
      const identityChecks = [this.identities.planStructureChange(await this.identities.readControl(), now),
        await this.identities.liveScope("game", [input.gameId]), await this.identities.liveScope("league", [input.leagueId]),
        await this.identities.liveScope("season", [input.leagueId, input.seasonId])];
      const joinCode = customJoinCode ?? generateJoinCode();
      const createRequestHash = input.createRequestHash?.trim() || null;
      const sessionTargets = linkSession
        ? await this.readSessionMutationTargets(input)
        : [];
      if (linkSession && sessionTargets.length === 0) {
        throw new GameMutationStateError(
          "game_state_changed",
          `Session ${input.sessionId} changed before the game could be created. Reload and try again.`,
        );
      }
      const payload = {
        gameId: input.gameId,
        joinCode,
        ...(createRequestHash ? { createRequestHash } : {}),
        leagueId: input.leagueId,
        seasonId: input.seasonId,
        sessionId: input.sessionId,
        status: input.status ?? "scheduled",
        gameStartTs: input.gameStartTs,
        thirdLengthMinutes: input.thirdLengthMinutes ?? DEFAULT_THIRD_LENGTH_MINUTES,
        thirds: createDefaultThirdTimerSegments(),
        finishedAt: null,
        result: null,
      };
      const sessionGamePayload = linkSession
        ? {
            sessionId: input.sessionId,
            gameId: input.gameId,
            gameStartTs: input.gameStartTs,
            leagueId: input.leagueId,
            seasonId: input.seasonId,
          }
        : null;
      const transactionItems: TransactWriteItem[] = [
        {
          Put: {
            TableName: this.tableName,
            Item: buildItem(gamePk(input.gameId), metadataSk(), ENTITY_TYPE.game, payload, now),
            ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          },
        },
        {
          Put: {
            TableName: this.tableName,
            Item: buildItem(
              joinCodePk(joinCode),
              metadataSk(),
              ENTITY_TYPE.gameJoinCode,
              {
                joinCode,
                gameId: input.gameId,
              },
              now,
            ),
            ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          },
        },
      ];
      if (sessionGamePayload) {
        transactionItems.push(
          {
            Put: {
              TableName: this.tableName,
              Item: buildItem(
                gameSessionIndexPk(input.sessionId),
                gameSessionIndexSk(input.gameStartTs, input.gameId),
                ENTITY_TYPE.sessionGame,
                sessionGamePayload,
                now,
              ),
              ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            },
          },
          ...sessionTargets.map((target) => this.buildConditionalPutFromStoredEntity(target, now)),
        );
      }
      transactionItems.push(...identityChecks);

      try {
        await this.client.send(
          new TransactWriteItemsCommand({
            TransactItems: transactionItems,
          }),
        );
        return withTimestamps(payload, now, now);
      } catch (error) {
        if (isConditionalWriteFailure(error)) {
          const gameCancellationCode = transactionCancellationCode(error, 0);
          const joinCodeCancellationCode = transactionCancellationCode(error, 1);
          if (isConditionalCancellationCode(gameCancellationCode ?? undefined)) {
            throw new GameAlreadyExistsError(input.gameId);
          }
          if (isConditionalCancellationCode(joinCodeCancellationCode ?? undefined)) {
            if (customJoinCode) {
              throw new GameJoinCodeCollisionError();
            }
            continue;
          }
          if (
            linkSession &&
            transactionItems
              .slice(2)
              .some((_, index) =>
                isConditionalCancellationCode(transactionCancellationCode(error, index + 2) ?? undefined),
              )
          ) {
            throw new GameMutationStateError(
              "game_state_changed",
              `Session ${input.sessionId} changed before the game could be created. Reload and try again.`,
            );
          }

          const [existingGameItem, existingJoinCodeItem] = await Promise.all([
            this.getEntity(gamePk(input.gameId), metadataSk(), { consistentRead: true }),
            this.getEntity(joinCodePk(joinCode), metadataSk(), { consistentRead: true }),
          ]);
          if (existingGameItem?.entityType === ENTITY_TYPE.game) {
            throw new GameAlreadyExistsError(input.gameId);
          }
          if (existingJoinCodeItem?.entityType === ENTITY_TYPE.gameJoinCode) {
            if (customJoinCode) {
              throw new GameJoinCodeCollisionError();
            }
            continue;
          }
        }

        throw error;
      }
    }

    throw new GameJoinCodeCollisionError();
  }

  async getGame(
    gameId: string,
    options: {
      consistentRead?: boolean;
      repairLegacyJoinCode?: boolean;
      expectedLeagueId?: string;
      expectedSeasonId?: string;
    } = {},
  ): Promise<GameRecord | null> {
    requireNonEmpty("gameId", gameId);
    const item = await this.getEntity(gamePk(gameId), metadataSk(), options);

    if (!item || item.entityType !== ENTITY_TYPE.game) {
      return null;
    }

    const game = withTimestamps(normalizeGamePayload(item.data), item.createdAt, item.updatedAt);
    if (options.repairLegacyJoinCode) {
      if (
        (options.expectedLeagueId !== undefined && game.leagueId !== options.expectedLeagueId) ||
        (options.expectedSeasonId !== undefined && game.seasonId !== options.expectedSeasonId)
      ) {
        return game;
      }

      return this.repairLegacyGameJoinCode(item);
    }

    return game;
  }

  async getGameByJoinCode(joinCode: string): Promise<GameRecord | null> {
    const normalizedJoinCode = normalizeJoinCode(joinCode);
    requireNonEmpty("joinCode", normalizedJoinCode);

    const joinCodeItem = await this.getEntity(joinCodePk(normalizedJoinCode), metadataSk(), {
      consistentRead: true,
    });
    if (joinCodeItem?.entityType === ENTITY_TYPE.gameJoinCode) {
      const joinCodeRecord = withTimestamps(
        joinCodeItem.data as Omit<GameJoinCodeRecord, "createdAt" | "updatedAt">,
        joinCodeItem.createdAt,
        joinCodeItem.updatedAt,
      );
      const gameItem = await this.getEntity(gamePk(joinCodeRecord.gameId), metadataSk(), {
        consistentRead: true,
      });
      if (!gameItem || gameItem.entityType !== ENTITY_TYPE.game) {
        return null;
      }

      const game = withTimestamps(
        normalizeGamePayload(gameItem.data),
        gameItem.createdAt,
        gameItem.updatedAt,
      );

      if (game && normalizeJoinCode(game.joinCode) === normalizedJoinCode) {
        return game;
      }
    }

    return null;
  }

  async joinGameByCode(input: JoinGameByCodeInput): Promise<JoinGameByCodeResult | null> {
    const normalizedJoinCode = normalizeJoinCode(input.joinCode);
    requireNonEmpty("joinCode", normalizedJoinCode);
    requireNonEmpty("playerId", input.playerId);
    requireNonEmpty("nickname", input.nickname);
    if (input.claimProof) {
      this.validateProofCreation(input.claimProof);
    }

    const joinCodeItem = await this.getEntity(joinCodePk(normalizedJoinCode), metadataSk(), {
      consistentRead: true,
    });
    if (!joinCodeItem || joinCodeItem.entityType !== ENTITY_TYPE.gameJoinCode) {
      return null;
    }

    const joinCodeRecord = withTimestamps(
      joinCodeItem.data as Omit<GameJoinCodeRecord, "createdAt" | "updatedAt">,
      joinCodeItem.createdAt,
      joinCodeItem.updatedAt,
    );
    const gameItem = await this.getEntity(gamePk(joinCodeRecord.gameId), metadataSk(), {
      consistentRead: true,
    });
    if (!gameItem || gameItem.entityType !== ENTITY_TYPE.game) {
      return null;
    }

    const game = withTimestamps(
      normalizeGamePayload(gameItem.data),
      gameItem.createdAt,
      gameItem.updatedAt,
    );
    if (normalizeJoinCode(game.joinCode) !== normalizedJoinCode) {
      return null;
    }

    const existingReplay = await this.readExistingJoinRegistration({
      game,
      playerId: input.playerId,
      nickname: input.nickname,
      claimProof: input.claimProof,
    });
    if (existingReplay) {
      return existingReplay;
    }

    const now = this.clock.now();
    const playerPayload = {
      playerId: input.playerId,
      nickname: input.nickname,
      claimedByUserId: null,
    };
    const membership = await this.planPlayerMembership(game, input.playerId, input.nickname, now);
    if (membership.playerId !== input.playerId) throw new PlayerIdentityError("player_identity_changed", 409,
      "This player already exists. Use their profile link instead.");
    const linkPayload = {
      gameId: game.gameId,
      playerId: input.playerId,
    };
    const linkingUnavailable = Boolean(input.claimProof && this.playerClaimMode === "disabled");
    const issueProof = input.claimProof && !linkingUnavailable;
    const leagueItem = issueProof
      ? await this.getEntity(leaguePk(game.leagueId), metadataSk(), { consistentRead: true }) : null;
    if (issueProof && (!leagueItem || leagueItem.entityType !== ENTITY_TYPE.league)) {
      throw new PlayerProofError("claim_context_unavailable", 409, "This game is no longer available to join.");
    }
    const claimProof: PlayerProofRecord | undefined = issueProof ? {
      proofId: input.claimProof!.proofId, verifier: input.claimProof!.verifier,
      kind: "registration", playerId: input.playerId, gameId: game.gameId,
      leagueId: game.leagueId, leagueName: (leagueItem!.data as LeagueRecord).name,
      playerRevision: createHash("sha256").update(JSON.stringify([JSON.stringify(playerPayload), now, now])).digest("hex"),
      identityRootId: membership.identity.root.value.playerId, identityVersion: membership.identity.root.value.identityVersion,
      expiresAt: new Date(Date.parse(now) + PLAYER_PROOF_TTL_MS).toISOString(),
      issuerAclUserId: null, replacesProofId: null, state: "pending", consumedByUserId: null, committedPlayer: null,
    } : undefined;

    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: boundedIdentityTransaction([
            ...membership.actions,
            ...(claimProof ? [this.proofWrite(claimProof, now), this.buildConditionalCheckFromStoredEntity(leagueItem!)] : []),
            ...(linkingUnavailable ? [{ Put: {
              TableName: this.tableName,
              Item: buildItem(gamePk(game.gameId), `JOIN_RECEIPT#${input.playerId}`, "gameJoinReceipt", {
                requestHash: createHash("sha256").update(JSON.stringify([input.nickname, input.claimProof!.proofId, input.claimProof!.verifier])).digest("hex"),
                linkingUnavailable: true,
              }, now),
              ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            } }] : []),
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: {
                  pk: { S: joinCodePk(normalizedJoinCode) },
                  sk: { S: metadataSk() },
                },
                ConditionExpression: "#updatedAt = :expectedJoinCodeUpdatedAt AND #data = :expectedJoinCodeData",
                ExpressionAttributeNames: {
                  "#updatedAt": "updatedAt",
                  "#data": "data",
                },
                ExpressionAttributeValues: {
                  ":expectedJoinCodeUpdatedAt": { S: joinCodeItem.updatedAt },
                  ":expectedJoinCodeData": { S: joinCodeItem.rawData },
                },
              },
            },
            {
              ConditionCheck: {
                TableName: this.tableName,
                Key: {
                  pk: { S: gamePk(game.gameId) },
                  sk: { S: metadataSk() },
                },
                ConditionExpression: "#updatedAt = :expectedGameUpdatedAt AND #data = :expectedGameData",
                ExpressionAttributeNames: {
                  "#updatedAt": "updatedAt",
                  "#data": "data",
                },
                ExpressionAttributeValues: {
                  ":expectedGameUpdatedAt": { S: game.updatedAt },
                  ":expectedGameData": { S: gameItem.rawData },
                },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: buildItem(playerPk(input.playerId), profileSk(), ENTITY_TYPE.player, playerPayload, now),
                ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: buildItem(
                  gamePk(game.gameId),
                  gamePlayerSk(input.playerId),
                  ENTITY_TYPE.gamePlayer,
                  linkPayload,
                  now,
                ),
                ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
          ]),
        }),
      );
    } catch (error) {
      if (isConditionalWriteFailure(error)) {
        const replayedJoin = await this.readExistingJoinRegistration({
          game,
          playerId: input.playerId,
          nickname: input.nickname,
          claimProof: input.claimProof,
        });
        if (replayedJoin) {
          return replayedJoin;
        }

        throw new GameJoinRegistrationError(
          "join_state_changed",
          409,
          "Game join state changed while registering this player. Reload and try again.",
        );
      }

      throw error;
    }

    return {
      game,
      player: withTimestamps(playerPayload, now, now),
      link: withTimestamps(linkPayload, now, now),
      ...(claimProof ? { claimProof: this.proofMetadata(claimProof) } : {}),
      ...(linkingUnavailable ? { linkingUnavailable: true as const } : {}),
    };
  }

  private async readExistingJoinRegistration(input: {
    game: GameRecord;
    playerId: string;
    nickname: string;
    claimProof?: PlayerProofCreation;
  }): Promise<JoinGameByCodeResult | null> {
    const [playerItem, linkItem] = await Promise.all([
      this.getEntity(playerPk(input.playerId), profileSk(), { consistentRead: true }),
      this.getEntity(gamePk(input.game.gameId), gamePlayerSk(input.playerId), {
        consistentRead: true,
      }),
    ]);
    if (playerItem?.entityType !== ENTITY_TYPE.player || linkItem?.entityType !== ENTITY_TYPE.gamePlayer) {
      return null;
    }

    const player = withTimestamps(
      playerItem.data as Omit<PlayerRecord, "createdAt" | "updatedAt">,
      playerItem.createdAt,
      playerItem.updatedAt,
    );
    const link = withTimestamps(
      linkItem.data as Omit<GamePlayerRecord, "createdAt" | "updatedAt">,
      linkItem.createdAt,
      linkItem.updatedAt,
    );

    if (
      player.playerId !== input.playerId ||
      player.nickname !== input.nickname ||
      (!input.claimProof && player.claimedByUserId !== null) ||
      link.gameId !== input.game.gameId ||
      link.playerId !== input.playerId
    ) {
      return null;
    }

    let proof: PlayerProofRecord | undefined;
    const disabledReceipt = await this.getEntity(gamePk(input.game.gameId), `JOIN_RECEIPT#${input.playerId}`, { consistentRead: true });
    const disabledHash = disabledReceipt?.entityType === "gameJoinReceipt"
      ? (disabledReceipt.data as { requestHash: string }).requestHash : undefined;
    if (disabledHash) {
      if (!input.claimProof || !secureEqual(disabledHash, createHash("sha256").update(JSON.stringify([
        input.nickname, input.claimProof.proofId, input.claimProof.verifier,
      ])).digest("hex"))) return null;
      // The original no-proof outcome survives mode changes and lost replies.
      // Never mint a capability retroactively onto this registration.
      return { game: input.game, player, link: { gameId: link.gameId, playerId: link.playerId,
        createdAt: link.createdAt, updatedAt: link.updatedAt }, linkingUnavailable: true };
    }
    if (input.claimProof) {
      const item = await this.getEntity(this.playerProofKey(input.claimProof.proofId), metadataSk(), { consistentRead: true });
      if (!item || item.entityType !== ENTITY_TYPE.playerProof) return null;
      proof = this.storedPlayerProof(item);
      if (proof.kind !== "registration" || proof.playerId !== input.playerId || proof.gameId !== input.game.gameId ||
          !secureEqual(proof.verifier, input.claimProof.verifier)) return null;
    }
    return {
      game: input.game,
      player,
      link,
      ...(proof ? { claimProof: this.proofMetadata(proof) } : {}),
    };
  }

  async createSessionGame(input: CreateSessionGameInput): Promise<SessionGameRecord> {
    requireNonEmpty("sessionId", input.sessionId);
    requireNonEmpty("gameId", input.gameId);
    requireNonEmpty("gameStartTs", input.gameStartTs);
    requireNonEmpty("leagueId", input.leagueId);
    requireNonEmpty("seasonId", input.seasonId);

    const [sessionTargets, guardedGameItem] = await Promise.all([
      this.readSessionMutationTargets(input),
      input.requireExistingGame === true
        ? this.getEntity(gamePk(input.gameId), metadataSk(), { consistentRead: true })
        : Promise.resolve(null),
    ]);
    if (sessionTargets.length === 0) {
      throw new GameMutationStateError(
        "game_state_changed",
        `Session ${input.sessionId} changed before the game could be linked. Reload and try again.`,
      );
    }
    if (input.requireExistingGame === true) {
      if (!guardedGameItem || guardedGameItem.entityType !== ENTITY_TYPE.game) {
        throw new GameMutationStateError(
          "game_state_changed",
          `Game ${input.gameId} changed before the session could be linked. Reload and try again.`,
        );
      }

      const guardedGame = normalizeGamePayload(guardedGameItem.data);
      if (
        guardedGame.gameId !== input.gameId ||
        guardedGame.leagueId !== input.leagueId ||
        guardedGame.seasonId !== input.seasonId ||
        guardedGame.sessionId !== input.sessionId ||
        guardedGame.gameStartTs !== input.gameStartTs
      ) {
        throw new GameMutationStateError(
          "game_state_changed",
          `Game ${input.gameId} changed before the session could be linked. Reload and try again.`,
        );
      }
    }

    const now = this.clock.now();
    const payload = {
      sessionId: input.sessionId,
      gameId: input.gameId,
      gameStartTs: input.gameStartTs,
      leagueId: input.leagueId,
      seasonId: input.seasonId,
    };

    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            ...(guardedGameItem ? [this.buildGameConditionCheck(input.gameId, guardedGameItem)] : []),
            {
              Put: {
                TableName: this.tableName,
                Item: buildItem(
                  gameSessionIndexPk(input.sessionId),
                  gameSessionIndexSk(input.gameStartTs, input.gameId),
                  ENTITY_TYPE.sessionGame,
                  payload,
                  now,
                ),
              },
            },
            ...sessionTargets.map((target) => this.buildConditionalPutFromStoredEntity(target, now)),
          ],
        }),
      );
    } catch (error) {
      if (isConditionalWriteFailure(error)) {
        if (
          guardedGameItem &&
          isConditionalCancellationCode(transactionCancellationCode(error, 0) ?? undefined)
        ) {
          throw new GameMutationStateError(
            "game_state_changed",
            `Game ${input.gameId} changed before the session could be linked. Reload and try again.`,
          );
        }

        throw new GameMutationStateError(
          "game_state_changed",
          `Session ${input.sessionId} changed before the game could be linked. Reload and try again.`,
        );
      }

      throw error;
    }

    return withTimestamps(payload, now, now);
  }

  async listGamesForSession(
    sessionId: string,
    options: { consistentRead?: boolean } = {},
  ): Promise<SessionGameRecord[]> {
    requireNonEmpty("sessionId", sessionId);
    const items = await this.queryByPrefix(gameSessionIndexPk(sessionId), "GAME#", {
      consistentRead: options.consistentRead,
    });

    return items
      .filter((item) => item.entityType === ENTITY_TYPE.sessionGame)
      .map((item) =>
        withTimestamps(
          item.data as Omit<SessionGameRecord, "createdAt" | "updatedAt">,
          item.createdAt,
          item.updatedAt,
        ),
      );
  }

  async listGamesForSeason(
    seasonId: string,
    options: { leagueId?: string; consistentRead?: boolean } = {},
  ): Promise<GameRecord[]> {
    requireNonEmpty("seasonId", seasonId);
    if (options.leagueId !== undefined) {
      requireNonEmpty("leagueId", options.leagueId);
    }

    const legacySeasonItem = options.leagueId
      ? await this.getEntity(seasonPk(seasonId), metadataSk(), {
          consistentRead: options.consistentRead,
        })
      : null;
    const canUseProvenanceLessLegacySessions =
      options.leagueId !== undefined &&
      this.isMatchingSeasonEntity(legacySeasonItem, {
        leagueId: options.leagueId,
        seasonId,
      });
    const scopedSessions = await this.listSessionsForSeason(seasonId, {
      leagueId: options.leagueId,
      consistentRead: options.consistentRead,
    });
    const legacySessions = options.leagueId
      ? (await this.listSessionsForSeason(seasonId, { consistentRead: options.consistentRead })).filter(
          (session) =>
            session.leagueId === options.leagueId ||
            (canUseProvenanceLessLegacySessions && session.leagueId === undefined),
        )
      : [];
    const sessions = [
      ...new Map(
        [...scopedSessions, ...legacySessions].map((session) => [session.sessionId, session]),
      ).values(),
    ];
    const sessionGames = await Promise.all(
      sessions.map((session) =>
        this.listGamesForSession(session.sessionId, {
          consistentRead: options.consistentRead,
        }),
      ),
    );

    const orderedSessionGames = sessionGames
      .flat()
      .sort((left, right) => {
        const timestampSort = left.gameStartTs.localeCompare(right.gameStartTs);
        if (timestampSort !== 0) {
          return timestampSort;
        }

        return left.gameId.localeCompare(right.gameId);
      });
    const scopedSessionGames = orderedSessionGames.filter((sessionGame) => {
      if (sessionGame.seasonId !== seasonId) {
        return false;
      }

      return !options.leagueId || sessionGame.leagueId === options.leagueId;
    });

    const gameRecords = await Promise.all(
      scopedSessionGames.map((sessionGame) =>
        this.getGame(sessionGame.gameId, { consistentRead: options.consistentRead }),
      ),
    );

    return gameRecords
      .filter((game): game is GameRecord => game !== null)
      .filter((game) => {
        if (game.seasonId !== seasonId) {
          return false;
        }

        return !options.leagueId || game.leagueId === options.leagueId;
      });
  }

  async updateGame(input: {
    gameId: string;
    status?: GameRecord["status"];
    gameStartTs?: string;
    thirdLengthMinutes?: ThirdLengthMinutes;
  }): Promise<GameRecord | null> {
    requireNonEmpty("gameId", input.gameId);

    if (
      input.status === undefined &&
      input.gameStartTs === undefined &&
      input.thirdLengthMinutes === undefined
    ) {
      throw new Error("At least one game field must be updated.");
    }

    const gameItem = await this.readMutableGameEntity(input.gameId);
    if (!gameItem || gameItem.entityType !== ENTITY_TYPE.game) {
      return null;
    }

    const existing = normalizeGamePayload(gameItem.data);
    const nextGameStartTs = input.gameStartTs ?? existing.gameStartTs;
    const nextStatus = input.status ?? existing.status;
    const nextThirdLengthMinutes = input.thirdLengthMinutes ?? existing.thirdLengthMinutes;

    if (input.status === "finished" && existing.status !== "finished") {
      throw new GameTimerTransitionError(
        "use_finish_endpoint",
        "Use POST /v1/games/{gameId}/finish to finish a game.",
      );
    }

    if (
      existing.status === "finished" &&
      input.status !== undefined &&
      input.status !== "finished"
    ) {
      throw new GameTimerTransitionError(
        "game_finished",
        "Finished games cannot be moved back to scheduled or live.",
      );
    }

    if (
      input.thirdLengthMinutes !== undefined &&
      input.thirdLengthMinutes !== existing.thirdLengthMinutes &&
      existing.status === "finished"
    ) {
      throw new GameTimerTransitionError(
        "game_finished",
        "Third length cannot be changed after the game is finished.",
      );
    }

    if (
      input.thirdLengthMinutes !== undefined &&
      input.thirdLengthMinutes !== existing.thirdLengthMinutes &&
      isThirdStarted(existing)
    ) {
      throw new GameTimerTransitionError(
        "third_length_locked",
        "Third length cannot be changed after a third has started.",
      );
    }

    if (input.status === "scheduled" && isThirdStarted(existing)) {
      throw new GameTimerTransitionError(
        "timer_status_locked",
        "Game status cannot be set back to scheduled after a third has started.",
      );
    }

    const updatedPayload = {
      ...existing,
      gameStartTs: nextGameStartTs,
      status: nextStatus,
      thirdLengthMinutes: nextThirdLengthMinutes,
    };

    const now = this.clock.now();

    let gameUpdated: boolean;
    if (nextGameStartTs !== existing.gameStartTs) {
      const control = await this.identities.readControl();
      const update = this.buildConditionalPutFromStoredEntity(gameItem, now);
      update.Put!.Item = buildItemWithTimestamps(gamePk(existing.gameId), metadataSk(), ENTITY_TYPE.game,
        updatedPayload, gameItem.createdAt, now);
      try {
        await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction([
          this.identities.planCoverageInvalidation(control, now), update,
        ]) }));
        gameUpdated = true;
      } catch (error) {
        if (!isConditionalWriteFailure(error)) throw error;
        gameUpdated = false;
      }
    } else gameUpdated = await this.putEntityWithTimestampsIfUnchanged(
      gamePk(existing.gameId),
      metadataSk(),
      ENTITY_TYPE.game,
      updatedPayload,
      gameItem.createdAt,
      now,
      {
        updatedAt: gameItem.updatedAt,
        rawData: gameItem.rawData,
      },
    );
    if (!gameUpdated) {
      throw new GameTimerTransitionError(
        "game_state_changed",
        "Game state changed while applying this update. Reload and try again.",
      );
    }

    const oldSessionGameSk = gameSessionIndexSk(existing.gameStartTs, existing.gameId);
    const oldSessionGameItem = await this.getEntity(
      gameSessionIndexPk(existing.sessionId),
      oldSessionGameSk,
    );

    if (oldSessionGameItem) {
      await this.deleteEntity(gameSessionIndexPk(existing.sessionId), oldSessionGameSk);
    }

    const sessionGameCreatedAt = oldSessionGameItem?.createdAt ?? now;
    await this.putEntityWithTimestamps(
      gameSessionIndexPk(existing.sessionId),
      gameSessionIndexSk(nextGameStartTs, existing.gameId),
      ENTITY_TYPE.sessionGame,
      {
        sessionId: existing.sessionId,
        gameId: existing.gameId,
        gameStartTs: nextGameStartTs,
        leagueId: existing.leagueId,
        seasonId: existing.seasonId,
      },
      sessionGameCreatedAt,
      now,
    );

    return withTimestamps(updatedPayload, gameItem.createdAt, now);
  }

  async startGameThird(input: ThirdTransitionInput): Promise<GameRecord | null> {
    requireNonEmpty("gameId", input.gameId);
    requireThirdNumber(input.third);

    const gameItem = await this.readMutableGameEntity(input.gameId);
    if (!gameItem || gameItem.entityType !== ENTITY_TYPE.game) {
      return null;
    }

    const existing = normalizeGamePayload(gameItem.data);
    if (existing.status === "finished") {
      throw new GameTimerTransitionError(
        "game_finished",
        "Cannot start a third after the game is finished.",
      );
    }

    const thirds = existing.thirds.map((third) => ({ ...third }));
    const target = thirds.find((third) => third.third === input.third);
    if (!target) {
      throw new GameTimerTransitionError("invalid_third", "Third must be 1, 2, or 3.");
    }

    if (target.startedAt) {
      throw new GameTimerTransitionError(
        "third_already_started",
        `Third ${input.third} has already been started.`,
      );
    }

    const runningThird = thirds.find((third) => third.startedAt && !third.finishedAt);
    if (runningThird) {
      throw new GameTimerTransitionError(
        "third_already_running",
        `Third ${runningThird.third} must be finished before another third can start.`,
      );
    }

    const previousThirds = thirds.filter((third) => third.third < input.third);
    const unfinishedPreviousThird = previousThirds.find((third) => !third.finishedAt);
    if (unfinishedPreviousThird) {
      throw new GameTimerTransitionError(
        "previous_third_unfinished",
        `Third ${unfinishedPreviousThird.third} must be finished before third ${input.third} can start.`,
      );
    }

    const now = this.clock.now();
    target.startedAt = now;
    const updatedPayload = {
      ...existing,
      status: "live" as const,
      thirds,
    };

    const transitionApplied = await this.putEntityWithTimestampsIfUnchanged(
      gamePk(existing.gameId),
      metadataSk(),
      ENTITY_TYPE.game,
      updatedPayload,
      gameItem.createdAt,
      now,
      {
        updatedAt: gameItem.updatedAt,
        rawData: gameItem.rawData,
      },
    );
    if (!transitionApplied) {
      throw new GameTimerTransitionError(
        "timer_state_changed",
        "Timer state changed while applying this transition. Reload the game and try again.",
      );
    }

    return withTimestamps(updatedPayload, gameItem.createdAt, now);
  }

  async finishGameThird(input: ThirdTransitionInput): Promise<GameRecord | null> {
    requireNonEmpty("gameId", input.gameId);
    requireThirdNumber(input.third);

    const gameItem = await this.readMutableGameEntity(input.gameId);
    if (!gameItem || gameItem.entityType !== ENTITY_TYPE.game) {
      return null;
    }

    const existing = normalizeGamePayload(gameItem.data);
    if (existing.status === "finished") {
      throw new GameTimerTransitionError(
        "game_finished",
        "Cannot finish a third after the game is finished.",
      );
    }

    const thirds = existing.thirds.map((third) => ({ ...third }));
    const target = thirds.find((third) => third.third === input.third);
    if (!target) {
      throw new GameTimerTransitionError("invalid_third", "Third must be 1, 2, or 3.");
    }

    if (!target.startedAt) {
      throw new GameTimerTransitionError(
        "third_not_started",
        `Third ${input.third} cannot be finished before it is started.`,
      );
    }

    if (target.finishedAt) {
      throw new GameTimerTransitionError(
        "third_already_finished",
        `Third ${input.third} has already been finished.`,
      );
    }

    const now = this.clock.now();
    target.finishedAt = now;
    const updatedPayload = {
      ...existing,
      status: existing.status === "scheduled" ? ("live" as const) : existing.status,
      thirds,
    };

    const transitionApplied = await this.putEntityWithTimestampsIfUnchanged(
      gamePk(existing.gameId),
      metadataSk(),
      ENTITY_TYPE.game,
      updatedPayload,
      gameItem.createdAt,
      now,
      {
        updatedAt: gameItem.updatedAt,
        rawData: gameItem.rawData,
      },
    );
    if (!transitionApplied) {
      throw new GameTimerTransitionError(
        "timer_state_changed",
        "Timer state changed while applying this transition. Reload the game and try again.",
      );
    }

    return withTimestamps(updatedPayload, gameItem.createdAt, now);
  }

  async finishGame(input: FinishGameInput): Promise<GameRecord | null> {
    requireNonEmpty("gameId", input.gameId);

    const gameItem = await this.readMutableGameEntity(input.gameId);
    if (!gameItem || gameItem.entityType !== ENTITY_TYPE.game) {
      return null;
    }

    const existing = normalizeGamePayload(gameItem.data);
    if (existing.status === "finished" && existing.finishedAt && isCompleteGameResult(existing.result)) {
      return withTimestamps(existing, gameItem.createdAt, gameItem.updatedAt);
    }

    if (existing.status === "finished") {
      const { teams, teamStatesById } = await this.readGoalTeamStates(input.gameId, {
        consistentRead: true,
      });
      const missingTeams = TEAM_IDS.filter((teamId) => !teamStatesById.has(teamId));
      if (missingTeams.length > 0) {
        throw new GameTimerTransitionError(
          "teams_not_ready",
          "All three game teams must exist before finishing the game.",
        );
      }

      const now = this.clock.now();
      const repairedGame = {
        ...existing,
        finishedAt: existing.finishedAt ?? now,
        result: isCompleteGameResult(existing.result) ? existing.result : buildGameResult(teams, now),
      };

      const repairApplied = await this.putEntityWithTimestampsIfUnchanged(
        gamePk(existing.gameId),
        metadataSk(),
        ENTITY_TYPE.game,
        repairedGame,
        gameItem.createdAt,
        now,
        {
          updatedAt: gameItem.updatedAt,
          rawData: gameItem.rawData,
        },
      );
      if (!repairApplied) {
        throw new GameTimerTransitionError(
          "game_state_changed",
          "Game changed while finishing. Reload the game and try again.",
        );
      }

      return withTimestamps(repairedGame, gameItem.createdAt, now);
    }

    const runningThird = existing.thirds.find((third) => third.startedAt && !third.finishedAt);
    if (runningThird) {
      throw new GameTimerTransitionError(
        "third_running",
        `Third ${runningThird.third} must be finished before the game can be finished.`,
      );
    }

    if (!areAllThirdsCompleted(existing)) {
      throw new GameTimerTransitionError(
        "thirds_incomplete",
        "All three thirds must be started and finished before the game can be finished.",
      );
    }

    const { teams, teamStatesById } = await this.readGoalTeamStates(input.gameId, {
      consistentRead: true,
    });
    const missingTeams = TEAM_IDS.filter((teamId) => !teamStatesById.has(teamId));
    if (missingTeams.length > 0) {
      throw new GameTimerTransitionError(
        "teams_not_ready",
        "All three game teams must exist before finishing the game.",
      );
    }

    const now = this.clock.now();
    const result = buildGameResult(teams, now);
    const updatedPayload = {
      ...existing,
      status: "finished" as const,
      finishedAt: existing.finishedAt ?? now,
      result,
    };

    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            this.buildGamePutTransactionItem({
              game: updatedPayload,
              stored: gameItem,
              now,
            }),
            ...this.buildTeamConditionChecks(teams, teamStatesById),
          ],
        }),
      );
    } catch (error) {
      if (!isConditionalWriteFailure(error)) {
        throw error;
      }

      throw new GameTimerTransitionError(
        "game_state_changed",
        "Game or scoreboard state changed while finishing this game. Reload and try again.",
      );
    }

    return withTimestamps(updatedPayload, gameItem.createdAt, now);
  }

  async deleteGame(gameId: string): Promise<boolean> {
    requireNonEmpty("gameId", gameId);

    const identityControl = await this.identities.readControl();

    const gameItem = await this.readMutableGameEntity(gameId);
    if (!gameItem || gameItem.entityType !== ENTITY_TYPE.game) {
      return false;
    }

    const game = normalizeGamePayload(gameItem.data);
    if (game.status === "finished") {
      return false;
    }

    const joinCodeItem = await this.getEntity(joinCodePk(game.joinCode), metadataSk(), {
      consistentRead: true,
    });
    const joinCodeRecord =
      joinCodeItem?.entityType === ENTITY_TYPE.gameJoinCode
        ? withTimestamps(
            joinCodeItem.data as Omit<GameJoinCodeRecord, "createdAt" | "updatedAt">,
            joinCodeItem.createdAt,
            joinCodeItem.updatedAt,
          )
        : null;
    const deletesJoinCodeLookup =
      joinCodeItem !== null &&
      joinCodeRecord?.gameId === gameId &&
      normalizeJoinCode(joinCodeRecord.joinCode) === normalizeJoinCode(game.joinCode);
    const sessionCleanupTargets = await this.readSessionMutationTargets(game);
    const transactionItems: TransactWriteItem[] = [
      ...await this.identities.planDeletion("game", [gameId], this.clock.now(), {
        gameId, leagueId: game.leagueId, seasonId: game.seasonId, gameStartTs: game.gameStartTs,
      }, identityControl),
      {
        Delete: {
          TableName: this.tableName,
          Key: {
            pk: { S: gamePk(gameId) },
            sk: { S: metadataSk() },
          },
          ConditionExpression: "#updatedAt = :expectedGameUpdatedAt AND #data = :expectedGameData",
          ExpressionAttributeNames: {
            "#updatedAt": "updatedAt",
            "#data": "data",
          },
          ExpressionAttributeValues: {
            ":expectedGameUpdatedAt": { S: gameItem.updatedAt },
            ":expectedGameData": { S: gameItem.rawData },
          },
        },
      },
      {
        Delete: {
          TableName: this.tableName,
          Key: {
            pk: { S: gameSessionIndexPk(game.sessionId) },
            sk: { S: gameSessionIndexSk(game.gameStartTs, game.gameId) },
          },
        },
      },
    ];
    if (deletesJoinCodeLookup && joinCodeItem) {
      transactionItems.push({
        Delete: {
          TableName: this.tableName,
          Key: {
            pk: { S: joinCodePk(game.joinCode) },
            sk: { S: metadataSk() },
          },
          ConditionExpression: "#updatedAt = :expectedJoinCodeUpdatedAt AND #data = :expectedJoinCodeData",
          ExpressionAttributeNames: {
            "#updatedAt": "updatedAt",
            "#data": "data",
          },
          ExpressionAttributeValues: {
            ":expectedJoinCodeUpdatedAt": { S: joinCodeItem.updatedAt },
            ":expectedJoinCodeData": { S: joinCodeItem.rawData },
          },
        },
      });
    }

    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: transactionItems,
        }),
      );
    } catch (error) {
      if (isConditionalWriteFailure(error)) {
        return false;
      }

      throw error;
    }

    const remainingGames = await this.listGamesForSession(game.sessionId, {
      consistentRead: true,
    });
    const hasRemainingGamesForDeletedScope = remainingGames.some(
      (remainingGame) =>
        remainingGame.leagueId === game.leagueId && remainingGame.seasonId === game.seasonId,
    );
    const sessionDeleteTargets: Array<StoredEntity<unknown>> = [];
    if (!hasRemainingGamesForDeletedScope) {
      sessionDeleteTargets.push(
        ...sessionCleanupTargets.filter(
          (target) =>
            (target.pk === seasonPk(game.seasonId) && target.sk === sessionSk(game.sessionId)) ||
            (target.pk === sessionPk(game.sessionId) && target.sk === metadataSk()),
        ),
      );
      sessionDeleteTargets.push(
        ...sessionCleanupTargets.filter(
          (target) =>
            target.pk === leaguePk(game.leagueId) &&
            target.sk === scopedSeasonSessionSk(game.seasonId, game.sessionId),
        ),
      );
    }
    await this.deleteSessionTargetsIfUnchanged(sessionDeleteTargets);

    return true;
  }

  async deleteSeason(
    seasonId: string,
    options: { leagueId?: string } = {},
  ): Promise<boolean> {
    requireNonEmpty("seasonId", seasonId);
    if (options.leagueId !== undefined) {
      requireNonEmpty("leagueId", options.leagueId);
    }

    const identityControl = await this.identities.readControl();

    const globalSeasonItem = await this.getEntity(seasonPk(seasonId), metadataSk(), {
      consistentRead: true,
    });
    const globalSeason =
      globalSeasonItem?.entityType === ENTITY_TYPE.season
        ? withTimestamps(
            globalSeasonItem.data as Omit<SeasonRecord, "createdAt" | "updatedAt">,
            globalSeasonItem.createdAt,
            globalSeasonItem.updatedAt,
          )
        : null;
    const season = options.leagueId
      ? await this.getEntity(leaguePk(options.leagueId), seasonSk(seasonId), {
          consistentRead: true,
        })
      : null;
    const scopedSeason =
      season?.entityType === ENTITY_TYPE.season
        ? withTimestamps(
            season.data as Omit<SeasonRecord, "createdAt" | "updatedAt">,
            season.createdAt,
            season.updatedAt,
          )
        : null;
    const resolvedSeason = scopedSeason ?? (!options.leagueId ? globalSeason : null);
    if (!resolvedSeason) {
      return false;
    }
    const canUseProvenanceLessLegacySessions =
      options.leagueId !== undefined &&
      this.isMatchingSeasonEntity(globalSeasonItem, {
        leagueId: options.leagueId,
        seasonId,
      });

    const scopedSessions = await this.listSessionsForSeason(seasonId, {
      leagueId: options.leagueId,
      consistentRead: true,
    });
    const legacySessions = options.leagueId
      ? (await this.listSessionsForSeason(seasonId, { consistentRead: true })).filter(
          (session) =>
            session.leagueId === options.leagueId ||
            (canUseProvenanceLessLegacySessions && session.leagueId === undefined),
        )
      : [];
    const sessions = [
      ...new Map(
        [...scopedSessions, ...legacySessions].map((session) => [session.sessionId, session]),
      ).values(),
    ];
    if (sessions.length > 0) {
      throw new Error("Cannot delete season with existing games.");
    }
    if (options.leagueId) {
      const games = await this.listGamesForSeason(seasonId, {
        leagueId: options.leagueId,
        consistentRead: true,
      });
      if (games.length > 0) {
        throw new Error("Cannot delete season with existing games.");
      }
    }

    if (options.leagueId) {
      if (!season || season.entityType !== ENTITY_TYPE.season) {
        return false;
      }
      const scopedTeamItems = await this.queryByPrefix(
        leaguePk(options.leagueId),
        `SEASON#${seasonId}#TEAM#`,
        { consistentRead: true },
      );
      const ownedLegacyTeamItems = await this.readOwnedLegacySeasonTeamTemplateItems(
        seasonId,
        options.leagueId,
      );

      const deleteItems: TransactWriteItem[] = [
        ...await this.identities.planDeletion("season", [options.leagueId, seasonId], this.clock.now(), undefined, identityControl),
        {
          Delete: {
            TableName: this.tableName,
            Key: {
              pk: { S: leaguePk(options.leagueId) },
              sk: { S: seasonSk(seasonId) },
            },
            ConditionExpression: "#scopedUpdatedAt = :expectedSeasonUpdatedAt AND #scopedData = :expectedSeasonData",
            ExpressionAttributeNames: {
              "#scopedUpdatedAt": "updatedAt",
              "#scopedData": "data",
            },
            ExpressionAttributeValues: {
              ":expectedSeasonUpdatedAt": { S: season.updatedAt },
              ":expectedSeasonData": { S: season.rawData },
            },
          },
        },
        ...scopedTeamItems
          .filter((item) => item.entityType === ENTITY_TYPE.team)
          .map((item) => this.buildConditionalDeleteFromStoredEntity(item)),
        ...ownedLegacyTeamItems
          .filter((item) => this.isMatchingSeasonTeamEntity(item, {
            seasonId,
            leagueId: options.leagueId,
          }))
          .map((item) => this.buildConditionalDeleteFromStoredEntity(item)),
      ];
      if (globalSeasonItem?.entityType === ENTITY_TYPE.season && globalSeason?.leagueId === options.leagueId) {
        deleteItems.push({
          Delete: {
            TableName: this.tableName,
            Key: {
              pk: { S: seasonPk(seasonId) },
              sk: { S: metadataSk() },
            },
            ConditionExpression: "#globalUpdatedAt = :expectedGlobalSeasonUpdatedAt AND #globalData = :expectedGlobalSeasonData",
            ExpressionAttributeNames: {
              "#globalUpdatedAt": "updatedAt",
              "#globalData": "data",
            },
            ExpressionAttributeValues: {
              ":expectedGlobalSeasonUpdatedAt": { S: globalSeasonItem.updatedAt },
              ":expectedGlobalSeasonData": { S: globalSeasonItem.rawData },
            },
          },
        });
      }

      try {
        await this.client.send(
          new TransactWriteItemsCommand({
            TransactItems: deleteItems,
          }),
        );
      } catch (error) {
        if (isConditionalWriteFailure(error)) {
          throw new Error("Cannot delete season with existing games.");
        }

        throw error;
      }
      return true;
    }

    const scoped = await this.getEntity(leaguePk(resolvedSeason.leagueId), seasonSk(seasonId), { consistentRead: true });
    await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction([
      ...await this.identities.planDeletion("season", [resolvedSeason.leagueId, seasonId], this.clock.now(), undefined, identityControl),
      this.buildConditionalDeleteFromStoredEntity(globalSeasonItem!),
      ...(scoped ? [this.buildConditionalDeleteFromStoredEntity(scoped)] : []),
    ]) }));
    return true;
  }

  async canResumeLeagueDeletion(leagueId: string, userIds: readonly string[]): Promise<boolean> {
    const cleanup = new LeagueDeletionCleanup(this.client, this.tableName, () => this.clock.now());
    const receipt = await cleanup.read(leagueId);
    return Boolean(receipt && cleanup.owns(receipt, userIds));
  }

  async deleteLeague(leagueId: string, userIds?: readonly string[]): Promise<boolean> {
    requireNonEmpty("leagueId", leagueId);
    const cleanup = new LeagueDeletionCleanup(this.client, this.tableName, () => this.clock.now());
    if (await cleanup.read(leagueId)) return cleanup.resume(leagueId, userIds);
    const identityControl = await this.identities.readControl();

    const league = await this.getEntity(leaguePk(leagueId), metadataSk(), { consistentRead: true });
    if (!league || league.entityType !== ENTITY_TYPE.league) {
      return false;
    }

    const seasons = await this.listSeasonsForLeague(leagueId, { consistentRead: true });
    if (seasons.length > 0) {
      throw new Error("Cannot delete league with existing seasons.");
    }

    let authority: StoredEntity<unknown> | null = null;
    if (userIds) {
      for (const userId of userIds) {
        const acl = await this.getEntity(leaguePk(leagueId), aclSk(userId), { consistentRead: true });
        if (acl?.entityType === ENTITY_TYPE.acl && (acl.data as LeagueAclRecord).role === "admin") { authority = acl; break; }
      }
      if (!authority) throw new PlayerIdentityError("league_cleanup_forbidden", 403, "Only a league organiser can remove this league.");
    }
    await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction([
      ...await this.identities.planDeletion("league", [leagueId], this.clock.now(), undefined, identityControl), this.buildConditionalDeleteFromStoredEntity(league),
      cleanup.start(leagueId, userIds), ...(authority ? [this.buildConditionalCheckFromStoredEntity(authority)!] : []),
    ]) }));
    return cleanup.resume(leagueId, userIds);
  }

  async createPlayer(input: CreatePlayerInput): Promise<PlayerRecord> {
    requireNonEmpty("playerId", input.playerId);
    requireNonEmpty("nickname", input.nickname);

    const now = this.clock.now();
    const payload = {
      playerId: input.playerId,
      nickname: input.nickname,
      claimedByUserId: input.claimedByUserId ?? null,
    };

    const existing = await this.getPlayer(input.playerId, { consistentRead: true });
    if (existing) {
      if (existing.nickname !== payload.nickname || existing.claimedByUserId !== payload.claimedByUserId) {
        throw new PlayerIdentityError("player_already_exists", 409, "This player already exists. Choose the existing player.");
      }
      return existing;
    }
    const control = await this.identities.readControl();
    const identity = await this.identities.resolve(input.playerId, input.nickname);
    if (identity.root.item) throw new PlayerIdentityError("player_identity_unavailable", 503, "This player record needs organiser support.");
    await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction([
      this.identities.writableControl(control), ...this.identities.planRevision(identity, now, payload.claimedByUserId !== null),
      { Put: { TableName: this.tableName, Item: buildItem(playerPk(input.playerId), profileSk(), ENTITY_TYPE.player, payload, now),
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
    ]) }));
    return withTimestamps(payload, now, now);
  }

  async getPlayer(playerId: string, options: { consistentRead?: boolean } = {}): Promise<PlayerRecord | null> {
    requireNonEmpty("playerId", playerId);
    const item = await this.getEntity(playerPk(playerId), profileSk(), options);

    if (!item || item.entityType !== ENTITY_TYPE.player) {
      return null;
    }

    return withTimestamps(item.data as Omit<PlayerRecord, "createdAt" | "updatedAt">, item.createdAt, item.updatedAt);
  }

  /** Presentation-only identity resolution. Ownership proofs and event writes
   * must keep using raw records and the original registered player ID. */
  async getPlayerView(playerId: string): Promise<{
    originalPlayerId: string; canonicalPlayerId: string; player: PlayerRecord;
  } | null> {
    requireNonEmpty("playerId", playerId);
    const original = await this.getEntity(playerPk(playerId), profileSk(), { consistentRead: true });
    if (!original || original.entityType !== ENTITY_TYPE.player) return null;
    const source = original.data as Omit<PlayerRecord, "createdAt" | "updatedAt">;
    if (!source || source.playerId !== playerId || typeof source.nickname !== "string") {
      throw new PlayerIdentityError("player_identity_unavailable", 503, "Player details could not be loaded. Try again.");
    }
    const identity = await this.identities.resolve(playerId, source.nickname);
    const canonicalId = identity.root.value.playerId;
    const canonical = canonicalId === playerId ? original : await this.getEntity(playerPk(canonicalId), profileSk(), { consistentRead: true });
    const owner = canonical?.data as Omit<PlayerRecord, "createdAt" | "updatedAt"> | undefined;
    if (!canonical || canonical.entityType !== ENTITY_TYPE.player || !owner || owner.playerId !== canonicalId ||
        typeof owner.nickname !== "string" || (owner.claimedByUserId !== null && typeof owner.claimedByUserId !== "string")) {
      throw new PlayerIdentityError("player_identity_unavailable", 503, "Player details could not be loaded. Try again.");
    }
    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction([
        identityCondition(this.tableName, identity.root), identityCondition(this.tableName, identity.original),
        this.buildConditionalCheckFromStoredEntity(original), this.buildConditionalCheckFromStoredEntity(canonical),
      ]) }));
    } catch (error) {
      if (isConditionalWriteFailure(error)) throw new PlayerIdentityError("player_identity_changed", 503, "Player details changed. Try again.");
      throw error;
    }
    return { originalPlayerId: playerId, canonicalPlayerId: canonicalId,
      player: withTimestamps({ ...source, nickname: identity.root.value.displayName, claimedByUserId: owner.claimedByUserId }, original.createdAt, original.updatedAt) };
  }

  private async leaguePlayerAuthority(leagueId: string, userIds: readonly string[], adminOnly = false): Promise<{
    league: StoredEntity<unknown>; acl: StoredEntity<unknown>; admin: boolean;
  }> {
    requireNonEmpty("leagueId", leagueId);
    const league = await this.getEntity(leaguePk(leagueId), metadataSk(), { consistentRead: true });
    if (!league || league.entityType !== ENTITY_TYPE.league || (league.data as LeagueRecord).leagueId !== leagueId) {
      throw new PlayerIdentityError("player_directory_unavailable", 403, "You cannot access this player list.");
    }
    // Only trusted session identities reach this method. Do not accept an
    // arbitrary account ID from a request body or a directory cursor.
    let scorer: StoredEntity<unknown> | null = null;
    for (const userId of [...new Set(userIds)]) {
      const acl = await this.getEntity(leaguePk(leagueId), aclSk(userId), { consistentRead: true });
      if (!acl || acl.entityType !== ENTITY_TYPE.acl) continue;
      const value = acl.data as LeagueAclRecord;
      if (value.leagueId !== leagueId || value.userId !== userId) continue;
      if (value.role === "admin") return { league, acl, admin: true };
      if (value.role === "scorekeeper") scorer = acl;
    }
    if (!adminOnly && scorer) return { league, acl: scorer, admin: false };
    throw new PlayerIdentityError("player_directory_unavailable", 403, "You cannot access this player list.");
  }

  async listLeaguePlayers(input: { leagueId: string; userIds: readonly string[]; seasonId?: string; gameId?: string;
    query?: string; cursor?: string; limit?: number }): Promise<{
      players: Array<{ playerId: string; nickname: string; claimed: boolean; seasons: Array<{ seasonId: string; name: string }>; hasMoreSeasons: boolean; inGame?: boolean }>;
      cursor: string | null;
    }> {
    const authority = await this.leaguePlayerAuthority(input.leagueId, input.userIds);
    const game = input.gameId === undefined ? null : await this.getEntity(gamePk(input.gameId), metadataSk(), { consistentRead: true });
    if (input.gameId !== undefined && (!game || game.entityType !== ENTITY_TYPE.game ||
        (game.data as GameRecord)?.gameId !== input.gameId || (game.data as GameRecord)?.leagueId !== input.leagueId)) {
      throw new PlayerIdentityError("game_unavailable", 404, "This game is no longer available.");
    }
    if (input.seasonId !== undefined && !await this.getSeasonForLeague(input.leagueId, input.seasonId, { consistentRead: true })) {
      throw new PlayerIdentityError("player_season_unavailable", 404, "This season is no longer available.");
    }
    const page = await this.identities.directoryPage(input);
    const players = [];
    for (const entry of page.entries) {
      const profile = await this.getPlayer(entry.playerId, { consistentRead: true });
      if (!profile || profile.playerId !== entry.playerId || typeof profile.nickname !== "string" ||
          (profile.claimedByUserId !== null && typeof profile.claimedByUserId !== "string")) {
        throw new PlayerIdentityError("player_identity_unavailable", 503, "The player list is being prepared. Please try again shortly.");
      }
      const seasons = [];
      for (const seasonId of input.seasonId === undefined ? entry.seasonIds ?? [] : [input.seasonId]) {
        const season = await this.getSeasonForLeague(input.leagueId, seasonId, { consistentRead: true });
        if (season?.leagueId === input.leagueId && season.seasonId === seasonId && typeof season.name === "string" && season.name.trim()) {
          seasons.push({ seasonId, name: season.name });
        }
      }
      players.push({ playerId: entry.playerId, nickname: entry.nickname, claimed: profile.claimedByUserId !== null,
        seasons, hasMoreSeasons: input.seasonId === undefined && entry.hasMoreSeasons === true,
        ...(input.gameId === undefined ? {} : { inGame: entry.inGame === true }) });
    }
    // Do not disclose a page obtained while the caller's league authority was
    // revoked. This read-only transaction checks the exact initial ACL snapshot.
    await this.client.send(new TransactWriteItemsCommand({ TransactItems: [
      this.buildConditionalCheckFromStoredEntity(authority.league)!, this.buildConditionalCheckFromStoredEntity(authority.acl)!,
      ...(game ? [this.buildConditionalCheckFromStoredEntity(game)] : []),
    ] }));
    return { players, cursor: page.cursor };
  }

  async createLeaguePlayer(input: { leagueId: string; playerId: string; nickname: string; userIds: readonly string[] }): Promise<{
    playerId: string; nickname: string;
  }> {
    requireNonEmpty("playerId", input.playerId); requireNonEmpty("nickname", input.nickname);
    const authority = await this.leaguePlayerAuthority(input.leagueId, input.userIds, true);
    const control = await this.identities.readControl(); this.identities.requireDirectory(control);
    const now = this.clock.now(), identity = await this.identities.resolve(input.playerId, input.nickname);
    const receipt = await this.getEntity(playerPk(input.playerId), "LEAGUE_CREATION", { consistentRead: true });
    const request = { leagueId: input.leagueId, playerId: input.playerId, nickname: input.nickname,
      actor: (authority.acl.data as LeagueAclRecord).userId };
    if (receipt) {
      const committed = receipt.data as typeof request | null;
      if (receipt.entityType !== "leaguePlayerCreation" || !committed || !input.userIds.includes(committed.actor) ||
          receipt.rawData !== JSON.stringify({ ...request, actor: committed.actor })) {
        throw new PlayerIdentityError("player_creation_changed", 409, "Start a new player entry.");
      }
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction([
        this.identities.writableControl(control), this.buildConditionalCheckFromStoredEntity(authority.league)!,
        this.buildConditionalCheckFromStoredEntity(authority.acl)!, this.buildConditionalCheckFromStoredEntity(receipt)!,
      ]) }));
      // Return the immutable creation outcome. A later merge or rename cannot
      // change the meaning of a lost-response retry; readers resolve aliases.
      return { playerId: committed.playerId, nickname: committed.nickname };
    }
    if (identity.root.item || await this.getPlayer(input.playerId, { consistentRead: true })) {
      throw new PlayerIdentityError("player_already_exists", 409, "Choose the existing player or start a new player entry.");
    }
    await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction([
      this.identities.writableControl(control), ...this.identities.planRevision(identity, now),
      ...await this.identities.planDirectory(identity, input.leagueId, now),
      await this.identities.liveScope("league", [input.leagueId]),
      this.buildConditionalCheckFromStoredEntity(authority.league)!, this.buildConditionalCheckFromStoredEntity(authority.acl)!,
      { Put: { TableName: this.tableName, Item: buildItem(playerPk(input.playerId), profileSk(), ENTITY_TYPE.player,
        { playerId: input.playerId, nickname: input.nickname, claimedByUserId: null }, now),
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
      { Put: { TableName: this.tableName, Item: buildItem(playerPk(input.playerId), "LEAGUE_CREATION", "leaguePlayerCreation", request, now),
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
    ]) }));
    return { playerId: input.playerId, nickname: input.nickname };
  }

  async addExistingLeaguePlayer(input: { gameId: string; playerId: string; userIds: readonly string[]; teamId?: TeamId | null;
    allowFinished?: boolean }): Promise<{ playerId: string; alreadyInGame: boolean }> {
    if (input.teamId != null && !TEAM_IDS.includes(input.teamId)) throw new PlayerIdentityError("invalid_team", 400, "Choose a team.");
    const initialGame = await this.readMutableGameEntity(input.gameId);
    if (!initialGame || initialGame.entityType !== ENTITY_TYPE.game) throw new PlayerIdentityError("game_unavailable", 404, "This game is no longer available.");
    const game = normalizeGamePayload(initialGame.data);
    const authority = await this.leaguePlayerAuthority(game.leagueId, input.userIds);
    const { item: gameItem } = await this.readGameForMutation({ gameId: input.gameId,
      allowFinished: authority.admin && input.allowFinished === true,
      finishedMessage: "This game is finished. Open result correction to change players.", changedMessage: "This game changed. Try again." });
    if (gameItem.rawData !== initialGame.rawData) throw new PlayerIdentityError("game_changed", 409, "This game changed. Try again.");
    const control = await this.identities.readControl(); this.identities.requireDirectory(control);
    const profile = await this.getPlayer(input.playerId, { consistentRead: true });
    if (!profile) throw new PlayerIdentityError("player_unavailable", 409, "Choose a player from this league.");
    const now = this.clock.now(), membership = await this.planPlayerMembership(game, input.playerId, profile.nickname, now);
    const rootId = membership.identity.root.value.playerId;
    const directory = await this.getEntity(leaguePk(game.leagueId), identityDirectorySk(rootId), { consistentRead: true });
    const entry = directory?.data as { playerId?: unknown; active?: unknown } | undefined;
    if (!directory || directory.entityType !== "leaguePlayer" || entry?.playerId !== rootId || entry.active !== true) {
      throw new PlayerIdentityError("player_unavailable", 409, "Choose a player from this league.");
    }
    const alreadyInGame = await this.identities.registeredOriginal(membership.identity, input.gameId) !== null;
    // The directory projection is updated by membership.actions itself. Its CAS
    // snapshot is taken before this read; do not add a duplicate ConditionCheck.
    const actions = [...membership.actions, this.identities.writableControl(control),
      this.buildGameConditionCheck(input.gameId, gameItem), this.buildConditionalCheckFromStoredEntity(authority.acl)!,
      this.buildConditionalCheckFromStoredEntity(authority.league)!];
    if (!alreadyInGame) {
      if (input.teamId && Buffer.byteLength(rosterSk(input.teamId, rootId)) > 1024) throw new PlayerIdentityError("player_roster_key_too_large", 400,
        "This legacy player profile cannot be assigned to this team. Ask the organiser for help.");
      actions.push({ Put: { TableName: this.tableName, Item: buildItem(gamePk(input.gameId), gamePlayerSk(rootId), ENTITY_TYPE.gamePlayer,
        { gameId: input.gameId, playerId: rootId }, now), ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } });
      if (input.teamId) actions.push({ Put: { TableName: this.tableName, Item: buildItem(gamePk(input.gameId), rosterSk(input.teamId, rootId), ENTITY_TYPE.roster,
        { gameId: input.gameId, teamId: input.teamId, playerId: rootId }, now), ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } });
    }
    await this.client.send(new TransactWriteItemsCommand({ TransactItems: boundedIdentityTransaction(actions) }));
    return { playerId: membership.playerId, alreadyInGame };
  }

  private playerProofKey(proofId: string): string {
    if (!PROOF_ID_PATTERN.test(proofId)) throw new PlayerProofError("invalid_claim_proof", 400, "This profile link is invalid or no longer available.");
    return `PLAYER_PROOF#${proofId}`;
  }

  private validateProofCreation(proof: PlayerProofCreation): void {
    this.playerProofKey(proof.proofId);
    if (!PROOF_VERIFIER_PATTERN.test(proof.verifier)) throw new PlayerProofError("invalid_claim_proof", 400, "Invalid profile-link request.");
  }

  private playerRevision(stored: StoredEntity<unknown>): string {
    return createHash("sha256").update(JSON.stringify([stored.rawData, stored.createdAt, stored.updatedAt])).digest("hex");
  }

  private proofMetadata(proof: PlayerProofRecord): PlayerProofMetadata {
    return { proofId: proof.proofId, expiresAt: proof.expiresAt };
  }

  private storedPlayerProof(stored: StoredEntity<unknown>): PlayerProofRecord {
    const proof = stored.data as Partial<PlayerProofRecord> | null;
    const text = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
    const date = (value: unknown): boolean => text(value) && Number.isFinite(Date.parse(value));
    const invalid = (): never => { throw new PlayerProofError("invalid_claim_proof", 404, "This profile link is invalid or no longer available."); };
    if (stored.entityType !== ENTITY_TYPE.playerProof || !proof || typeof proof !== "object" ||
        !text(proof.proofId) || !PROOF_ID_PATTERN.test(proof.proofId) ||
        stored.pk !== `PLAYER_PROOF#${proof.proofId}` || stored.sk !== metadataSk() ||
        !text(proof.verifier) || !PROOF_VERIFIER_PATTERN.test(proof.verifier) ||
        !text(proof.playerRevision) || !PROOF_VERIFIER_PATTERN.test(proof.playerRevision) ||
        !text(proof.playerId) || !text(proof.leagueId) || !text(proof.leagueName) ||
        !date(proof.expiresAt) || !["registration", "invitation"].includes(proof.kind ?? "") ||
        !["pending", "revoked", "consumed"].includes(proof.state ?? "")) return invalid();
    if (proof.scope === "league" ? proof.kind !== "invitation" || proof.gameId !== null :
        (proof.scope !== undefined && proof.scope !== "game") || !text(proof.gameId)) return invalid();
    if (proof.kind === "registration") {
      if (proof.issuerAclUserId !== null || proof.replacesProofId !== null) return invalid();
    } else if (!text(proof.issuerAclUserId) ||
        (proof.replacesProofId !== null && (!text(proof.replacesProofId) || !PROOF_ID_PATTERN.test(proof.replacesProofId)))) return invalid();
    if (proof.identityRootId !== undefined || proof.identityVersion !== undefined) {
      if (!text(proof.identityRootId) || !Number.isSafeInteger(proof.identityVersion) || proof.identityVersion! < 0) return invalid();
    }
    if (proof.state === "consumed") {
      const player = proof.committedPlayer;
      // Receipt recovery ignores elapsed expiry, not malformed identity data.
      if (!text(proof.consumedByUserId) || !player || typeof player !== "object" ||
          player.playerId !== proof.playerId || player.claimedByUserId !== proof.consumedByUserId ||
          !text(player.nickname) || !date(player.createdAt) || !date(player.updatedAt)) return invalid();
    } else if (proof.consumedByUserId !== null || proof.committedPlayer !== null) return invalid();
    return proof as PlayerProofRecord;
  }

  private proofWrite(proof: PlayerProofRecord, now: string, existing?: StoredEntity<unknown>): TransactWriteItem {
    const item = buildItemWithTimestamps(this.playerProofKey(proof.proofId), metadataSk(), ENTITY_TYPE.playerProof,
      proof, existing?.createdAt ?? now, now);
    // Replacing the complete item on consumption removes the unused-proof TTL
    // atomically with ownership. Durable receipts contain no bearer secret.
    if (proof.state !== "consumed") item.ttlEpoch = { N: String(Math.ceil(Date.parse(proof.expiresAt) / 1000)) };
    const write = existing ? this.buildConditionalPutFromStoredEntity(existing, now) : {
      Put: { TableName: this.tableName, Item: item, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" },
    };
    write.Put!.Item = item;
    return write;
  }

  private async readProof(credential: PlayerProofCredential): Promise<{ stored: StoredEntity<unknown>; proof: PlayerProofRecord }> {
    const verifier = hashPlayerProofSecret(credential.secret);
    const stored = await this.getEntity(this.playerProofKey(credential.proofId), metadataSk(), { consistentRead: true });
    if (!stored) {
      throw new PlayerProofError("invalid_claim_proof", 404, "This profile link is invalid or no longer available.");
    }
    const proof = this.storedPlayerProof(stored);
    if (!secureEqual(proof.verifier, verifier)) throw new PlayerProofError("invalid_claim_proof", 404, "This profile link is invalid or no longer available.");
    return { stored, proof };
  }

  private async readProofContext(proof: PlayerProofRecord): Promise<{
    player: StoredEntity<unknown>; checks: TransactWriteItem[];
    identity: ResolvedPlayerIdentity; control: IdentitySnapshot<IdentityControl>;
  }> {
    requirePlayerClaimEnabled(this.playerClaimMode);
    if (proof.state !== "pending" || Date.parse(proof.expiresAt) <= Date.parse(this.clock.now())) {
      throw new PlayerProofError("claim_proof_unavailable", 409, "This profile link has expired or is no longer available. Ask the organiser for a new link.");
    }
    const [player, game, league, registration] = await Promise.all([
      this.getEntity(playerPk(proof.playerId), profileSk(), { consistentRead: true }),
      proof.scope === "league" ? Promise.resolve(null) : this.getEntity(gamePk(proof.gameId!), metadataSk(), { consistentRead: true }),
      this.getEntity(leaguePk(proof.leagueId), metadataSk(), { consistentRead: true }),
      proof.scope === "league" ? this.getEntity(leaguePk(proof.leagueId), identityDirectorySk(proof.playerId), { consistentRead: true }) :
        this.getEntity(gamePk(proof.gameId!), gamePlayerSk(proof.playerId), { consistentRead: true }),
    ]);
    const associationValid = proof.scope === "league" ? registration?.entityType === ENTITY_TYPE.leaguePlayer &&
      (registration.data as { playerId: string; active: boolean }).playerId === proof.playerId && (registration.data as { active: boolean }).active === true :
      game?.entityType === ENTITY_TYPE.game && (game.data as GameRecord).leagueId === proof.leagueId &&
      registration?.entityType === ENTITY_TYPE.gamePlayer && (registration.data as GamePlayerRecord).playerId === proof.playerId &&
      (registration.data as GamePlayerRecord).gameId === proof.gameId;
    if (!player || player.entityType !== ENTITY_TYPE.player || !associationValid ||
        !league || league.entityType !== ENTITY_TYPE.league || !registration || this.playerRevision(player) !== proof.playerRevision ||
        (player.data as PlayerRecord).claimedByUserId !== null) {
      throw new PlayerProofError("claim_profile_changed", 409, "This player is no longer available to link. Ask the organiser for help.");
    }
    const identity = await this.identities.resolve(proof.playerId, (player.data as PlayerRecord).nickname);
    const control = await this.identities.readControl();
    if (identity.root.value.playerId !== (proof.identityRootId ?? proof.playerId) ||
        identity.root.value.identityVersion !== (proof.identityVersion ?? 0) || identity.root.value.playerId !== proof.playerId) {
      throw new PlayerProofError("claim_profile_changed", 409, "This player profile changed. Ask the organiser for a new link.");
    }
    if (proof.scope === "league") this.identities.requireDirectory(control);
    const checks = [...(game ? [game] : []), league, registration].map((item) => this.buildConditionalCheckFromStoredEntity(item));
    if (proof.kind === "invitation") {
      const [acl, pointer] = await Promise.all([
        this.getEntity(leaguePk(proof.leagueId), aclSk(proof.issuerAclUserId!), { consistentRead: true }),
        this.getEntity(playerPk(proof.playerId), "CLAIM_INVITATION", { consistentRead: true }),
      ]);
      if (!acl || acl.entityType !== ENTITY_TYPE.acl || (acl.data as LeagueAclRecord).role !== "admin" ||
          !pointer || (pointer.data as { proofId: string | null }).proofId !== proof.proofId) {
        throw new PlayerProofError("claim_proof_unavailable", 409, "This profile link is no longer available. Ask the organiser for a new link.");
      }
      checks.push(this.buildConditionalCheckFromStoredEntity(acl), this.buildConditionalCheckFromStoredEntity(pointer));
    }
    if (Date.parse(proof.expiresAt) <= Date.parse(this.clock.now())) {
      throw new PlayerProofError("claim_proof_unavailable", 409, "This profile link has expired. Ask the organiser for a new link.");
    }
    return { player, checks, identity, control };
  }

  private async invitationAuthority(input: PlayerInvitationTarget): Promise<{
    game?: StoredEntity<unknown>; league: StoredEntity<unknown>; player: StoredEntity<unknown>;
    registration: StoredEntity<unknown>; acl: StoredEntity<unknown>;
  }> {
    if (input.scope === "league") {
      const authority = await this.leaguePlayerAuthority(input.leagueId, input.userIds, true);
      this.identities.requireDirectory(await this.identities.readControl());
      const [player, registration] = await Promise.all([
        this.getEntity(playerPk(input.playerId), profileSk(), { consistentRead: true }),
        this.getEntity(leaguePk(input.leagueId), identityDirectorySk(input.playerId), { consistentRead: true }),
      ]);
      if (!player || player.entityType !== ENTITY_TYPE.player || !registration || registration.entityType !== ENTITY_TYPE.leaguePlayer ||
          (registration.data as { playerId: string; active: boolean }).playerId !== input.playerId || (registration.data as { active: boolean }).active !== true) {
        throw new PlayerProofError("claim_context_unavailable", 404, "This player is not available in this league.");
      }
      return { league: authority.league, acl: authority.acl, player, registration };
    }
    if (Buffer.byteLength(gamePlayerSk(input.playerId)) > 1024) {
      throw new PlayerProofError("claim_context_unavailable", 404, "This player is not available in this game.");
    }
    const [game, player, registration] = await Promise.all([
      this.getEntity(gamePk(input.gameId), metadataSk(), { consistentRead: true }),
      this.getEntity(playerPk(input.playerId), profileSk(), { consistentRead: true }),
      this.getEntity(gamePk(input.gameId), gamePlayerSk(input.playerId), { consistentRead: true }),
    ]);
    if (!game || game.entityType !== ENTITY_TYPE.game || !player || player.entityType !== ENTITY_TYPE.player ||
        !registration || registration.entityType !== ENTITY_TYPE.gamePlayer) {
      throw new PlayerProofError("claim_context_unavailable", 404, "This player is not available in this game.");
    }
    const leagueId = (game.data as GameRecord).leagueId;
    const league = await this.getEntity(leaguePk(leagueId), metadataSk(), { consistentRead: true });
    if (!league || league.entityType !== ENTITY_TYPE.league) throw new PlayerProofError("claim_context_unavailable", 404, "This league is no longer available.");
    // Preserve the exact legacy-email or subject ACL key that authorised this
    // operation; redemption cannot substitute a different account's ACL.
    for (const userId of [...new Set(input.userIds)]) {
      const acl = await this.getEntity(leaguePk(leagueId), aclSk(userId), { consistentRead: true });
      if (acl?.entityType === ENTITY_TYPE.acl && (acl.data as LeagueAclRecord).role === "admin") {
        return { game, league, player, registration, acl };
      }
    }
    throw new PlayerProofError("claim_invite_forbidden", 403, "Only a league organiser can manage profile links.");
  }

  private async replayPlayerInvitation(stored: StoredEntity<unknown>): Promise<PlayerProofMetadata> {
    const proof = this.storedPlayerProof(stored);
    try {
      const context = await this.readProofContext(proof);
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: [
        ...context.checks, this.buildConditionalCheckFromStoredEntity(context.player),
        identityCondition(this.tableName, context.control), identityCondition(this.tableName, context.identity.root),
        this.buildConditionalCheckFromStoredEntity(stored),
      ] }));
      if (Date.parse(proof.expiresAt) <= Date.parse(this.clock.now())) {
        throw new PlayerProofError("claim_invite_changed", 409, "This profile link has expired. Check it before trying again.");
      }
      return this.proofMetadata(proof);
    } catch (error) {
      if (error instanceof PlayerProofError || isConditionalWriteFailure(error)) {
        throw new PlayerProofError("claim_invite_changed", 409, "This profile link changed. Check it before trying again.");
      }
      throw error;
    }
  }

  async createPlayerInvitation(input: PlayerProofCreation & PlayerInvitationTarget & {
    replacesProofId?: string | null;
  }): Promise<PlayerProofMetadata> {
    requirePlayerClaimEnabled(this.playerClaimMode);
    this.validateProofCreation(input);
    const context = await this.invitationAuthority(input);
    const league = context.league.data as LeagueRecord;
    const issuerAclUserId = (context.acl.data as LeagueAclRecord).userId;
    const existing = await this.getEntity(this.playerProofKey(input.proofId), metadataSk(), { consistentRead: true });
    if (existing) {
      const proof = this.storedPlayerProof(existing);
      if (existing.entityType === ENTITY_TYPE.playerProof && proof.kind === "invitation" &&
          proof.playerId === input.playerId && proof.gameId === (input.gameId ?? null) && (proof.scope ?? "game") === (input.scope ?? "game") && proof.leagueId === league.leagueId &&
          proof.issuerAclUserId !== null && input.userIds.includes(proof.issuerAclUserId) &&
          proof.replacesProofId === (input.replacesProofId ?? null) &&
          secureEqual(proof.verifier, input.verifier)) return this.replayPlayerInvitation(existing);
      throw new PlayerProofError("claim_request_changed", 409, "This profile-link request changed. Start a new request.");
    }
    if ((context.player.data as PlayerRecord).claimedByUserId !== null) {
      throw new PlayerProofError("player_already_claimed", 409, "This player is already linked to an account.");
    }
    const pointer = await this.getEntity(playerPk(input.playerId), "CLAIM_INVITATION", { consistentRead: true });
    const priorPointer = pointer?.data as { proofId?: string; leagueId?: string } | undefined;
    if (priorPointer?.leagueId !== undefined && priorPointer.leagueId !== league.leagueId) {
      throw new PlayerProofError("claim_invite_unavailable", 404, "This profile link is not available here.");
    }
    if (priorPointer?.proofId) {
      const prior = await this.getEntity(this.playerProofKey(priorPointer.proofId), metadataSk(), { consistentRead: true });
      if (prior && this.storedPlayerProof(prior).leagueId !== league.leagueId) {
        throw new PlayerProofError("claim_invite_unavailable", 404, "This profile link is not available here.");
      }
    }
    if (((pointer?.data as { proofId: string | null } | undefined)?.proofId ?? null) !== (input.replacesProofId ?? null)) {
      throw new PlayerProofError("claim_invite_changed", 409, "Another profile link exists. Check it before replacing it.");
    }
    const now = this.clock.now();
    const proof: PlayerProofRecord = {
      proofId: input.proofId, verifier: input.verifier, kind: "invitation", playerId: input.playerId,
      ...(input.scope === "league" ? { scope: "league" as const } : {}),
      gameId: input.gameId ?? null, leagueId: league.leagueId, leagueName: league.name,
      playerRevision: this.playerRevision(context.player), issuerAclUserId,
      replacesProofId: input.replacesProofId ?? null,
      expiresAt: new Date(Date.parse(now) + PLAYER_PROOF_TTL_MS).toISOString(),
      state: "pending", consumedByUserId: null, committedPlayer: null,
    };
    const identity = await this.identities.resolve(input.playerId, (context.player.data as PlayerRecord).nickname);
    const control = await this.identities.readControl();
    if (identity.root.value.playerId !== input.playerId) throw new PlayerProofError("claim_profile_changed", 409, "Use the retained player's profile link.");
    proof.identityRootId = identity.root.value.playerId; proof.identityVersion = identity.root.value.identityVersion;
    const pointerItem = buildItemWithTimestamps(playerPk(input.playerId), "CLAIM_INVITATION", ENTITY_TYPE.playerProofPointer,
      { proofId: proof.proofId, expiresAt: proof.expiresAt, leagueId: league.leagueId }, pointer?.createdAt ?? now, now);
    const pointerWrite: TransactWriteItem = pointer ? this.buildConditionalPutFromStoredEntity(pointer, now) : {
      Put: { TableName: this.tableName, Item: pointerItem, ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" },
    };
    pointerWrite.Put!.Item = pointerItem;
    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: [
        ...Object.values(context).filter((item): item is StoredEntity<unknown> => Boolean(item)).map((item) => this.buildConditionalCheckFromStoredEntity(item)),
        this.identities.writableControl(control), ...this.identities.planRevision(identity, now),
        this.proofWrite(proof, now), pointerWrite,
      ] }));
    } catch (error) {
      if (!isConditionalWriteFailure(error)) throw error;
      const replay = await this.getEntity(this.playerProofKey(input.proofId), metadataSk(), { consistentRead: true });
      const data = replay ? this.storedPlayerProof(replay) : undefined;
      // ACL preference can change between attempts (legacy email -> subject).
      // The persisted issuer must still belong to this caller; replay then
      // transactionally rechecks that exact issuer's current admin grant.
      if (replay?.entityType === ENTITY_TYPE.playerProof && data?.kind === "invitation" && data.playerId === input.playerId && data.gameId === (input.gameId ?? null) &&
          (data.scope ?? "game") === (input.scope ?? "game") && data.leagueId === league.leagueId &&
          data.issuerAclUserId !== null && input.userIds.includes(data.issuerAclUserId) &&
          data.replacesProofId === (input.replacesProofId ?? null) &&
          secureEqual(data.verifier, input.verifier)) return this.replayPlayerInvitation(replay);
      throw new PlayerProofError("claim_invite_changed", 409, "The player or organiser access changed. Check the player before trying again.");
    }
    return this.proofMetadata(proof);
  }

  async getPlayerInvitation(input: PlayerInvitationTarget): Promise<(PlayerProofMetadata & { state: string }) | null> {
    const context = await this.invitationAuthority(input);
    const pointer = await this.getEntity(playerPk(input.playerId), "CLAIM_INVITATION", { consistentRead: true });
    const pointerLeagueId = (pointer?.data as { leagueId?: string } | undefined)?.leagueId;
    if (pointerLeagueId !== undefined && pointerLeagueId !== (context.league.data as LeagueRecord).leagueId) {
      throw new PlayerProofError("claim_invite_unavailable", 404, "This profile link is not available here.");
    }
    const proofId = (pointer?.data as { proofId: string | null } | undefined)?.proofId;
    if (!proofId) return null;
    const item = await this.getEntity(this.playerProofKey(proofId), metadataSk(), { consistentRead: true });
    if (!item || item.entityType !== ENTITY_TYPE.playerProof) {
      // TTL may have removed the old proof, but its pointer still fences a
      // replacement. Return that ID rather than trapping creation on a hidden
      // predecessor the organiser cannot acknowledge.
      return { proofId, expiresAt: (pointer!.data as { expiresAt: string }).expiresAt, state: "expired" };
    }
    const proof = this.storedPlayerProof(item);
    if (proof.leagueId !== (context.league.data as LeagueRecord).leagueId || proof.playerId !== input.playerId || proof.kind !== "invitation") {
      throw new PlayerProofError("claim_invite_unavailable", 404, "This profile link is not available here.");
    }
    return { ...this.proofMetadata(proof), state: proof.state === "pending" && Date.parse(proof.expiresAt) <= Date.parse(this.clock.now()) ? "expired" : proof.state };
  }

  async revokePlayerInvitation(input: PlayerInvitationTarget & { proofId: string }): Promise<void> {
    const context = await this.invitationAuthority(input);
    const control = await this.identities.readControl();
    const identity = await this.identities.resolve(input.playerId, (context.player.data as PlayerRecord).nickname);
    const pointer = await this.getEntity(playerPk(input.playerId), "CLAIM_INVITATION", { consistentRead: true });
    const pointerLeagueId = (pointer?.data as { leagueId?: string } | undefined)?.leagueId;
    if (pointerLeagueId !== undefined && pointerLeagueId !== (context.league.data as LeagueRecord).leagueId) {
      throw new PlayerProofError("claim_invite_unavailable", 404, "This profile link is not available here.");
    }
    if ((pointer?.data as { proofId?: string } | undefined)?.proofId !== input.proofId) {
      throw new PlayerProofError("claim_invite_changed", 409, "This profile link changed. Check it before trying again.");
    }
    const item = await this.getEntity(this.playerProofKey(input.proofId), metadataSk(), { consistentRead: true });
    const proof = item ? this.storedPlayerProof(item) : undefined;
    if (proof && (proof.kind !== "invitation" || proof.playerId !== input.playerId || proof.leagueId !== (context.league.data as LeagueRecord).leagueId)) {
      throw new PlayerProofError("claim_invite_unavailable", 404, "This profile link is not available.");
    }
    const now = this.clock.now();
    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: [
        ...Object.values(context).filter((value): value is StoredEntity<unknown> => Boolean(value)).map((value) => this.buildConditionalCheckFromStoredEntity(value)),
        this.identities.writableControl(control), ...this.identities.planRevision(identity, now),
        this.buildConditionalCheckFromStoredEntity(pointer!),
        proof?.state === "pending" ? this.proofWrite({ ...proof, state: "revoked" }, now, item!)
          : item ? this.buildConditionalCheckFromStoredEntity(item)
            : { ConditionCheck: { TableName: this.tableName,
              Key: { pk: { S: this.playerProofKey(input.proofId) }, sk: { S: metadataSk() } },
              ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            } },
      ] }));
    } catch (error) {
      if (!isConditionalWriteFailure(error)) throw error;
      throw new PlayerProofError("claim_invite_changed", 409, "This profile link changed. Check it before trying again.");
    }
  }

  async previewPlayerProof(input: PlayerProofCredential & { userId: string; sessionId: string }): Promise<PlayerProofPreview> {
    requireNonEmpty("userId", input.userId);
    requireNonEmpty("sessionId", input.sessionId);
    const { proof } = await this.readProof(input);
    let player: Pick<PlayerRecord, "playerId" | "nickname">;
    if (proof.state === "consumed") {
      if (proof.consumedByUserId !== input.userId || !proof.committedPlayer) {
        throw new PlayerProofError("player_already_claimed", 409, "This player is already linked to an account. Ask the organiser for help.");
      }
      player = proof.committedPlayer;
    } else {
      player = (await this.readProofContext(proof)).player.data as PlayerRecord;
    }
    return {
      ...this.proofMetadata(proof),
      player: { playerId: player.playerId, nickname: player.nickname },
      league: { leagueId: proof.leagueId, name: proof.leagueName },
      alreadyLinked: proof.state === "consumed",
      confirmation: createPlayerConfirmation({ ...input, revision: proof.playerRevision }, Date.parse(this.clock.now())),
    };
  }

  private async claimPlayerWithProof(input: ClaimPlayerInput): Promise<PlayerRecord> {
    requireNonEmpty("sessionId", input.sessionId ?? "");
    const credential = input.proof!;
    const { stored, proof } = await this.readProof(credential);
    if (proof.playerId !== input.playerId) throw new PlayerProofError("invalid_claim_proof", 400, "This link is for a different player.");
    verifyPlayerConfirmation({ sessionId: input.sessionId!, userId: input.userId, proofId: proof.proofId,
      revision: proof.playerRevision }, credential.confirmation, Date.parse(this.clock.now()));
    if (proof.state === "consumed") {
      if (proof.consumedByUserId === input.userId && proof.committedPlayer) return proof.committedPlayer;
      throw new PlayerProofError("player_already_claimed", 409, "This player is already linked to an account. Ask the organiser for help.");
    }
    const context = await this.readProofContext(proof);
    const claimsRevision = await readPlayerClaimsRevision(this.client, this.tableName, input.userId);
    const now = this.clock.now();
    verifyPlayerConfirmation({ sessionId: input.sessionId!, userId: input.userId, proofId: proof.proofId,
      revision: proof.playerRevision }, credential.confirmation, Date.parse(now));
    const payload = { ...(context.player.data as Omit<PlayerRecord, "createdAt" | "updatedAt">), claimedByUserId: input.userId };
    const committedPlayer = withTimestamps(payload, context.player.createdAt, now);
    const playerWrite = this.buildConditionalPutFromStoredEntity(context.player, now);
    playerWrite.Put!.Item = buildItemWithTimestamps(playerPk(input.playerId), profileSk(), ENTITY_TYPE.player,
      payload, context.player.createdAt, now);
    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: [
        this.identities.writableControl(context.control), ...this.identities.planRevision(context.identity, now, true),
        advancePlayerClaimsRevision(this.tableName, claimsRevision, now),
        ...context.checks, playerWrite,
        this.proofWrite({ ...proof, state: "consumed", consumedByUserId: input.userId, committedPlayer }, now, stored),
        { Put: { TableName: this.tableName, Item: buildItem(userPk(input.userId), playerClaimSk(input.playerId),
          ENTITY_TYPE.playerClaim, { userId: input.userId, playerId: input.playerId }, now),
          ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)" } },
      ] }));
    } catch (error) {
      if (!isConditionalWriteFailure(error)) throw error;
      const latest = await this.readProof(credential);
      if (latest.proof.state === "consumed" && latest.proof.consumedByUserId === input.userId && latest.proof.committedPlayer) {
        return latest.proof.committedPlayer;
      }
      throw new PlayerProofError("claim_state_changed", 409, "This profile link changed. Please check it again before continuing.");
    }
    return committedPlayer;
  }

  async claimPlayer(input: ClaimPlayerInput): Promise<PlayerRecord | null> {
    requireNonEmpty("playerId", input.playerId);
    requireNonEmpty("userId", input.userId);
    if (input.proof) return this.claimPlayerWithProof(input);

    const playerItem = await this.getEntity(playerPk(input.playerId), profileSk(), {
      consistentRead: true,
    });
    if (!playerItem || playerItem.entityType !== ENTITY_TYPE.player) {
      return null;
    }

    const player = withTimestamps(
      playerItem.data as Omit<PlayerRecord, "createdAt" | "updatedAt">,
      playerItem.createdAt,
      playerItem.updatedAt,
    );
    if (player.claimedByUserId === input.userId) {
      return player;
    }
    throw new PlayerProofError("claim_proof_required", 403, "Use a private profile link to link this player. Ask the organiser for help.");
  }

  async listPlayers(input: ListPlayersInput = {}): Promise<PlayerRecord[]> {
    const rawSearch = input.search?.trim().toLowerCase() ?? "";
    const limit = Math.max(1, Math.min(input.limit ?? 20, 50));
    const scanResult = (await this.client.send(
      new ScanCommand({
        TableName: this.tableName,
      }),
    )) as ScanCommandOutput;

    return (scanResult.Items ?? [])
      .filter((item) => item.entityType?.S === ENTITY_TYPE.player)
      .map((item) => parseStoredEntity<Omit<PlayerRecord, "createdAt" | "updatedAt">>(item))
      .map((item) => withTimestamps(item.data, item.createdAt, item.updatedAt))
      .filter((player) => rawSearch.length === 0 || player.nickname.toLowerCase().includes(rawSearch))
      .sort((left, right) => {
        const updatedSort = right.updatedAt.localeCompare(left.updatedAt);
        if (updatedSort !== 0) {
          return updatedSort;
        }

        return left.nickname.localeCompare(right.nickname);
      })
      .slice(0, limit);
  }

  async linkGamePlayer(input: LinkGamePlayerInput): Promise<GamePlayerRecord> {
    requireNonEmpty("gameId", input.gameId);
    requireNonEmpty("playerId", input.playerId);

    const { item: gameItem } = await this.readGameForMutation({
      gameId: input.gameId,
      allowFinished: input.allowFinished,
      finishedMessage: `Game ${input.gameId} is finished. Admin role is required to mutate finished games.`,
      changedMessage: `Game ${input.gameId} changed before the player link could be saved. Reload and try again.`,
    });
    const now = this.clock.now();
    const requestedPlayer = await this.getPlayer(input.playerId, { consistentRead: true });
    if (!requestedPlayer) throw new PlayerIdentityError("player_not_found", 409, "This player is no longer available.");
    const membership = await this.planPlayerMembership(normalizeGamePayload(gameItem.data), input.playerId, requestedPlayer.nickname, now);
    input = { ...input, playerId: membership.playerId };
    const existing = await this.getEntity(gamePk(input.gameId), gamePlayerSk(input.playerId));
    const payload = {
      gameId: input.gameId,
      playerId: input.playerId,
    };

    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: boundedIdentityTransaction([
            ...membership.actions,
            this.buildGameConditionCheck(input.gameId, gameItem),
            {
              Put: {
                TableName: this.tableName,
                Item: buildItemWithTimestamps(
                  gamePk(input.gameId),
                  gamePlayerSk(input.playerId),
                  ENTITY_TYPE.gamePlayer,
                  payload,
                  existing?.createdAt ?? now,
                  now,
                ),
              },
            },
          ]),
        }),
      );
    } catch (error) {
      if (isConditionalWriteFailure(error)) {
        throw new GameMutationStateError(
          "game_state_changed",
          `Game ${input.gameId} changed before the player link could be saved. Reload and try again.`,
        );
      }

      throw error;
    }

    return withTimestamps(payload, existing?.createdAt ?? now, now);
  }

  async createAndLinkGamePlayer(input: CreateAndLinkGamePlayerInput): Promise<PlayerRecord> {
    requireNonEmpty("gameId", input.gameId);
    requireNonEmpty("playerId", input.playerId);
    requireNonEmpty("nickname", input.nickname);

    const { item: gameItem } = await this.readGameForMutation({
      gameId: input.gameId,
      allowFinished: input.allowFinished,
      finishedMessage: `Game ${input.gameId} is finished. Admin role is required to mutate finished games.`,
      changedMessage: `Game ${input.gameId} changed before the player could be saved. Reload and try again.`,
    });
    const now = this.clock.now();
    const requestedPlayer = await this.getPlayer(input.playerId, { consistentRead: true });
    const membership = await this.planPlayerMembership(normalizeGamePayload(gameItem.data), input.playerId, requestedPlayer?.nickname ?? input.nickname, now);
    input = { ...input, playerId: membership.playerId };
    const existingPlayerItem = await this.getEntity(playerPk(input.playerId), profileSk(), {
      consistentRead: true,
    });
    const existingPlayer =
      existingPlayerItem?.entityType === ENTITY_TYPE.player
        ? withTimestamps(
            existingPlayerItem.data as Omit<PlayerRecord, "createdAt" | "updatedAt">,
            existingPlayerItem.createdAt,
            existingPlayerItem.updatedAt,
          )
        : null;
    const playerPayload = existingPlayer
      ? {
          playerId: existingPlayer.playerId,
          nickname: existingPlayer.nickname,
          claimedByUserId: existingPlayer.claimedByUserId,
        }
      : {
          playerId: input.playerId,
          nickname: input.nickname,
          claimedByUserId: input.claimedByUserId ?? null,
        };
    const existingGamePlayer = await this.getEntity(
      gamePk(input.gameId),
      gamePlayerSk(input.playerId),
      { consistentRead: true },
    );
    const linkPayload = {
      gameId: input.gameId,
      playerId: input.playerId,
    };

    try {
      const transactionItems: TransactWriteItem[] = [
        ...membership.actions,
        this.buildGameConditionCheck(input.gameId, gameItem),
        {
          Put: {
            TableName: this.tableName,
            Item: buildItemWithTimestamps(
              gamePk(input.gameId),
              gamePlayerSk(input.playerId),
              ENTITY_TYPE.gamePlayer,
              linkPayload,
              existingGamePlayer?.createdAt ?? now,
              now,
            ),
          },
        },
      ];

      if (!existingPlayer) {
        transactionItems.splice(1, 0, {
          Put: {
            TableName: this.tableName,
            Item: buildItem(playerPk(input.playerId), profileSk(), ENTITY_TYPE.player, playerPayload, now),
            ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          },
        });
      }

      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: boundedIdentityTransaction(transactionItems),
        }),
      );
    } catch (error) {
      if (isConditionalWriteFailure(error)) {
        throw new GameMutationStateError(
          "game_state_changed",
          `Game ${input.gameId} changed before the player could be saved. Reload and try again.`,
        );
      }

      throw error;
    }

    return withTimestamps(
      playerPayload,
      existingPlayer?.createdAt ?? now,
      existingPlayer?.updatedAt ?? now,
    );
  }

  async getGamePlayer(gameId: string, playerId: string): Promise<GamePlayerRecord | null> {
    requireNonEmpty("gameId", gameId);
    requireNonEmpty("playerId", playerId);
    const item = await this.getEntity(gamePk(gameId), gamePlayerSk(playerId), { consistentRead: true });
    if (item?.entityType !== ENTITY_TYPE.gamePlayer) return null;
    const link = withTimestamps(item.data as Omit<GamePlayerRecord, "createdAt" | "updatedAt">, item.createdAt, item.updatedAt);
    return link.gameId === gameId && link.playerId === playerId ? link : null;
  }

  async listGamePlayers(gameId: string, options: { complete?: boolean; consistentRead?: boolean } = {}): Promise<GamePlayerRecord[]> {
    requireNonEmpty("gameId", gameId);
    const items = options.complete
      ? await this.queryCompleteGameRoster(gameId, "PLAYER#", options)
      : await this.queryByPrefix(gamePk(gameId), "PLAYER#", options);

    return items
      .filter((item) => item.entityType === ENTITY_TYPE.gamePlayer)
      .map((item) =>
        withTimestamps(
          item.data as Omit<GamePlayerRecord, "createdAt" | "updatedAt">,
          item.createdAt,
          item.updatedAt,
        ),
      );
  }

  private async liveLeagueForAuthority(leagueId: string): Promise<StoredEntity<unknown>> {
    const league = await this.getEntity(leaguePk(leagueId), metadataSk(), { consistentRead: true });
    if (!league || league.entityType !== ENTITY_TYPE.league) throw new PlayerIdentityError("league_unavailable", 404, "This league is no longer available.");
    return league;
  }

  async grantLeagueAccess(input: GrantLeagueAccessInput): Promise<LeagueAclRecord> {
    requireNonEmpty("leagueId", input.leagueId);
    requireNonEmpty("userId", input.userId);
    requireLeagueRole(input.role);
    requireNonEmpty("grantedByUserId", input.grantedByUserId);

    const pk = leaguePk(input.leagueId);
    const sk = aclSk(input.userId);

    for (;;) {
      const league = await this.liveLeagueForAuthority(input.leagueId);
      const existingItem = await this.getEntity(pk, sk, { consistentRead: true });
      const existing =
        existingItem?.entityType === ENTITY_TYPE.acl
          ? withTimestamps(
              existingItem.data as Omit<LeagueAclRecord, "createdAt" | "updatedAt">,
              existingItem.createdAt,
              existingItem.updatedAt,
            )
          : null;

      const role = existing ? higherLeagueRole(existing.role, input.role) : input.role;
      if (existing && role === existing.role) {
        return existing;
      }

      const now = this.clock.now();
      const payload = {
        leagueId: input.leagueId,
        userId: input.userId,
        role,
        grantedByUserId: input.grantedByUserId,
      };

      try {
        await this.client.send(
          new TransactWriteItemsCommand({ TransactItems: [this.buildConditionalCheckFromStoredEntity(league)!, { Put: {
            TableName: this.tableName,
            Item: buildItemWithTimestamps(
              pk,
              sk,
              ENTITY_TYPE.acl,
              payload,
              existing?.createdAt ?? now,
              now,
            ),
            ...(existingItem
              ? {
                  ConditionExpression: "#updatedAt = :expectedUpdatedAt AND #data = :expectedData",
                  ExpressionAttributeNames: {
                    "#updatedAt": "updatedAt",
                    "#data": "data",
                  },
                  ExpressionAttributeValues: {
                    ":expectedUpdatedAt": { S: existingItem.updatedAt },
                    ":expectedData": { S: existingItem.rawData },
                  },
                }
              : {
                  ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                }),
          } }] }),
        );
        return withTimestamps(payload, existing?.createdAt ?? now, now);
      } catch (error) {
        if (isConditionalWriteFailure(error)) {
          continue;
        }

        throw error;
      }
    }
  }

  async listLeagueAccess(leagueId: string): Promise<LeagueAclRecord[]> {
    requireNonEmpty("leagueId", leagueId);
    const items = await this.queryByPrefix(leaguePk(leagueId), "ACL#USER#");

    return items
      .filter((item) => item.entityType === ENTITY_TYPE.acl)
      .map((item) =>
        withTimestamps(
          item.data as Omit<LeagueAclRecord, "createdAt" | "updatedAt">,
          item.createdAt,
          item.updatedAt,
        ),
      );
  }

  async getLeagueAccess(leagueId: string, userId: string): Promise<LeagueAclRecord | null> {
    requireNonEmpty("leagueId", leagueId);
    requireNonEmpty("userId", userId);
    const item = await this.getEntity(leaguePk(leagueId), aclSk(userId));

    if (!item || item.entityType !== ENTITY_TYPE.acl) {
      return null;
    }

    return withTimestamps(
      item.data as Omit<LeagueAclRecord, "createdAt" | "updatedAt">,
      item.createdAt,
      item.updatedAt,
    );
  }

  async createLeagueOrganiserInvite(
    input: CreateLeagueOrganiserInviteInput,
  ): Promise<LeagueInviteRecord> {
    requireNonEmpty("leagueId", input.leagueId);
    requireNonEmpty("createdByUserId", input.createdByUserId);

    const email = normalizeInviteEmail(input.email);
    const kind = input.kind ?? "email";
    if (kind === "share") {
      return this.ensureLeagueOrganiserShareInvite({
        leagueId: input.leagueId,
        createdByUserId: input.createdByUserId,
      });
    }

    const customInviteCode = input.inviteCode ? normalizeCustomJoinCode(input.inviteCode) : null;

    for (let attempt = 0; attempt < JOIN_CODE_GENERATION_ATTEMPTS; attempt += 1) {
      const league = await this.liveLeagueForAuthority(input.leagueId);
      const inviteCode = customInviteCode ?? generateJoinCode();
      const now = this.clock.now();
      const payload: Omit<LeagueInviteRecord, "createdAt" | "updatedAt"> = {
        leagueId: input.leagueId,
        inviteCode,
        kind,
        role: "admin",
        email,
        createdByUserId: input.createdByUserId,
        acceptedByUserId: null,
        acceptedAt: null,
      };

      try {
        await this.client.send(
          new TransactWriteItemsCommand({ TransactItems: [this.buildConditionalCheckFromStoredEntity(league)!, { Put: {
            TableName: this.tableName,
            Item: buildItem(leagueInvitePk(inviteCode), metadataSk(), ENTITY_TYPE.leagueInvite, payload, now),
            ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
          } }] }),
        );
        return withTimestamps(payload, now, now);
      } catch (error) {
        if (isConditionalWriteFailure(error)) {
          if (customInviteCode) {
            throw new LeagueInviteCodeCollisionError();
          }
          continue;
        }

        throw error;
      }
    }

    throw new LeagueInviteCodeCollisionError();
  }

  private async getExistingLeagueOrganiserShareInvite(
    leagueId: string,
  ): Promise<LeagueInviteRecord | null> {
    const pointerItem = await this.getEntity(leaguePk(leagueId), leagueOrganiserShareInviteSk(), {
      consistentRead: true,
    });
    if (!pointerItem || pointerItem.entityType !== ENTITY_TYPE.leagueInvitePointer) {
      return null;
    }

    const pointer = normalizeLeagueInvitePointerPayload(pointerItem.data);
    if (pointer.leagueId !== leagueId || pointer.inviteCode.length === 0) {
      return null;
    }

    const invite = await this.getLeagueOrganiserInvite(pointer.inviteCode);
    if (
      invite &&
      invite.kind === "share" &&
      invite.leagueId === leagueId &&
      invite.email === null
    ) {
      return invite;
    }

    return null;
  }

  private async ensureLeagueOrganiserShareInvite(input: {
    leagueId: string;
    createdByUserId: string;
  }): Promise<LeagueInviteRecord> {
    for (let attempt = 0; attempt < JOIN_CODE_GENERATION_ATTEMPTS; attempt += 1) {
      const league = await this.liveLeagueForAuthority(input.leagueId);
      const existingInvite = await this.getExistingLeagueOrganiserShareInvite(input.leagueId);
      if (existingInvite) {
        return existingInvite;
      }

      const inviteCode = generateJoinCode();
      const now = this.clock.now();
      const payload: Omit<LeagueInviteRecord, "createdAt" | "updatedAt"> = {
        leagueId: input.leagueId,
        inviteCode,
        kind: "share",
        role: "admin",
        email: null,
        createdByUserId: input.createdByUserId,
        acceptedByUserId: null,
        acceptedAt: null,
      };

      try {
        await this.client.send(
          new TransactWriteItemsCommand({
            TransactItems: [this.buildConditionalCheckFromStoredEntity(league)!,
              {
                Put: {
                  TableName: this.tableName,
                  Item: buildItem(
                    leagueInvitePk(inviteCode),
                    metadataSk(),
                    ENTITY_TYPE.leagueInvite,
                    payload,
                    now,
                  ),
                  ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                },
              },
              {
                Put: {
                  TableName: this.tableName,
                  Item: buildItem(
                    leaguePk(input.leagueId),
                    leagueOrganiserShareInviteSk(),
                    ENTITY_TYPE.leagueInvitePointer,
                    { leagueId: input.leagueId, inviteCode },
                    now,
                  ),
                  ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                },
              },
            ],
          }),
        );
        return withTimestamps(payload, now, now);
      } catch (error) {
        if (isConditionalWriteFailure(error)) {
          continue;
        }

        throw error;
      }
    }

    await this.liveLeagueForAuthority(input.leagueId);
    const existingInvite = await this.getExistingLeagueOrganiserShareInvite(input.leagueId);
    if (existingInvite) {
      return existingInvite;
    }

    throw new LeagueInviteCodeCollisionError();
  }

  async getLeagueOrganiserInvite(inviteCode: string): Promise<LeagueInviteRecord | null> {
    const normalizedInviteCode = normalizeJoinCode(inviteCode);
    requireNonEmpty("inviteCode", normalizedInviteCode);

    const item = await this.getEntity(leagueInvitePk(normalizedInviteCode), metadataSk(), {
      consistentRead: true,
    });
    if (!item || item.entityType !== ENTITY_TYPE.leagueInvite) {
      return null;
    }

    return withTimestamps(
      normalizeLeagueInvitePayload(item.data),
      item.createdAt,
      item.updatedAt,
    );
  }

  async acceptLeagueOrganiserInvite(
    input: AcceptLeagueOrganiserInviteInput,
  ): Promise<AcceptLeagueOrganiserInviteResult | null> {
    const normalizedInviteCode = normalizeJoinCode(input.inviteCode);
    const normalizedEmail = normalizeInviteEmail(input.email);
    requireNonEmpty("inviteCode", normalizedInviteCode);
    requireNonEmpty("userId", input.userId);
    requireNonEmpty("email", normalizedEmail ?? "");

    for (;;) {
      const inviteItem = await this.getEntity(leagueInvitePk(normalizedInviteCode), metadataSk(), {
        consistentRead: true,
      });
      if (!inviteItem || inviteItem.entityType !== ENTITY_TYPE.leagueInvite) {
        return null;
      }

      const invite = withTimestamps(
        normalizeLeagueInvitePayload(inviteItem.data),
        inviteItem.createdAt,
        inviteItem.updatedAt,
      );
      if (invite.email && invite.email !== normalizedEmail) {
        throw new LeagueInviteError(
          "invite_email_mismatch",
          403,
          "This organiser invite was issued for a different email address.",
        );
      }

      const isShareInvite = invite.kind === "share";
      if (!isShareInvite && invite.acceptedByUserId !== null && invite.acceptedByUserId !== input.userId) {
        throw new LeagueInviteError(
          "invite_already_accepted",
          409,
          "This organiser invite has already been accepted.",
        );
      }

      const leagueItem = await this.getEntity(leaguePk(invite.leagueId), metadataSk(), {
        consistentRead: true,
      });
      if (!leagueItem || leagueItem.entityType !== ENTITY_TYPE.league) {
        throw new LeagueInviteError(
          "invite_scope_not_found",
          404,
          `League ${invite.leagueId} was not found for this organiser invite.`,
        );
      }

      const accessItem = await this.getEntity(leaguePk(invite.leagueId), aclSk(input.userId), {
        consistentRead: true,
      });
      const existingAccess =
        accessItem?.entityType === ENTITY_TYPE.acl
          ? withTimestamps(
              accessItem.data as Omit<LeagueAclRecord, "createdAt" | "updatedAt">,
              accessItem.createdAt,
              accessItem.updatedAt,
            )
          : null;
      const nextRole = existingAccess ? higherLeagueRole(existingAccess.role, invite.role) : invite.role;
      const needsInviteAcceptance = !isShareInvite && invite.acceptedByUserId === null;
      const needsAccessWrite = !existingAccess || nextRole !== existingAccess.role;

      if (!needsInviteAcceptance && !needsAccessWrite && existingAccess) {
        return {
          invite,
          access: existingAccess,
        };
      }

      const now = this.clock.now();
      const acceptedInvitePayload: Omit<LeagueInviteRecord, "createdAt" | "updatedAt"> = {
        leagueId: invite.leagueId,
        inviteCode: invite.inviteCode,
        kind: invite.kind,
        role: invite.role,
        email: invite.email,
        createdByUserId: invite.createdByUserId,
        acceptedByUserId: isShareInvite ? null : invite.acceptedByUserId ?? input.userId,
        acceptedAt: isShareInvite ? null : invite.acceptedAt ?? now,
      };
      const accessPayload: Omit<LeagueAclRecord, "createdAt" | "updatedAt"> = {
        leagueId: invite.leagueId,
        userId: input.userId,
        role: nextRole,
        grantedByUserId: invite.createdByUserId,
      };
      const transactionItems: TransactWriteItem[] = [
        {
          ConditionCheck: {
            TableName: this.tableName,
            Key: {
              pk: { S: leaguePk(invite.leagueId) },
              sk: { S: metadataSk() },
            },
            ConditionExpression: "#updatedAt = :expectedLeagueUpdatedAt AND #data = :expectedLeagueData",
            ExpressionAttributeNames: {
              "#updatedAt": "updatedAt",
              "#data": "data",
            },
            ExpressionAttributeValues: {
              ":expectedLeagueUpdatedAt": { S: leagueItem.updatedAt },
              ":expectedLeagueData": { S: leagueItem.rawData },
            },
          },
        },
        needsInviteAcceptance
          ? {
              Put: {
                TableName: this.tableName,
                Item: buildItemWithTimestamps(
                  leagueInvitePk(invite.inviteCode),
                  metadataSk(),
                  ENTITY_TYPE.leagueInvite,
                  acceptedInvitePayload,
                  invite.createdAt,
                  now,
                ),
                ConditionExpression: "#updatedAt = :expectedInviteUpdatedAt AND #data = :expectedInviteData",
                ExpressionAttributeNames: {
                  "#updatedAt": "updatedAt",
                  "#data": "data",
                },
                ExpressionAttributeValues: {
                  ":expectedInviteUpdatedAt": { S: inviteItem.updatedAt },
                  ":expectedInviteData": { S: inviteItem.rawData },
                },
              },
            }
          : {
              ConditionCheck: {
                TableName: this.tableName,
                Key: {
                  pk: { S: leagueInvitePk(invite.inviteCode) },
                  sk: { S: metadataSk() },
                },
                ConditionExpression: "#updatedAt = :expectedInviteUpdatedAt AND #data = :expectedInviteData",
                ExpressionAttributeNames: {
                  "#updatedAt": "updatedAt",
                  "#data": "data",
                },
                ExpressionAttributeValues: {
                  ":expectedInviteUpdatedAt": { S: inviteItem.updatedAt },
                  ":expectedInviteData": { S: inviteItem.rawData },
                },
              },
            },
      ];

      if (needsAccessWrite) {
        transactionItems.push({
          Put: {
            TableName: this.tableName,
            Item: buildItemWithTimestamps(
              leaguePk(invite.leagueId),
              aclSk(input.userId),
              ENTITY_TYPE.acl,
              accessPayload,
              existingAccess?.createdAt ?? now,
              now,
            ),
            ...(accessItem
              ? {
                  ConditionExpression: "#updatedAt = :expectedAccessUpdatedAt AND #data = :expectedAccessData",
                  ExpressionAttributeNames: {
                    "#updatedAt": "updatedAt",
                    "#data": "data",
                  },
                  ExpressionAttributeValues: {
                    ":expectedAccessUpdatedAt": { S: accessItem.updatedAt },
                    ":expectedAccessData": { S: accessItem.rawData },
                  },
                }
              : {
                  ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
                }),
          },
        });
      }

      try {
        await this.client.send(
          new TransactWriteItemsCommand({
            TransactItems: transactionItems,
          }),
        );
      } catch (error) {
        if (isConditionalWriteFailure(error)) {
          continue;
        }

        throw error;
      }

      return {
        invite: withTimestamps(
          acceptedInvitePayload,
          invite.createdAt,
          needsInviteAcceptance ? now : invite.updatedAt,
        ),
        access: withTimestamps(
          accessPayload,
          existingAccess?.createdAt ?? now,
          needsAccessWrite ? now : existingAccess?.updatedAt ?? now,
        ),
      };
    }
  }

  async assignRosterPlayer(input: AssignRosterInput): Promise<RosterAssignmentRecord> {
    requireNonEmpty("gameId", input.gameId);
    requireNonEmpty("playerId", input.playerId);

    const gameItem = await this.getEntity(gamePk(input.gameId), metadataSk(), { consistentRead: true });
    if (!gameItem || gameItem.entityType !== ENTITY_TYPE.game) {
      throw new GameMutationStateError(
        "game_state_changed",
        `Game ${input.gameId} changed before the roster assignment could be saved. Reload and try again.`,
      );
    }

    const game = normalizeGamePayload(gameItem.data);
    if (game.status === "finished" && input.allowFinished !== true) {
      throw new GameMutationStateError(
        "game_finished",
        `Game ${input.gameId} is finished. Admin role is required to mutate finished games.`,
      );
    }
    const now = this.clock.now();
    const requestedPlayer = await this.getPlayer(input.playerId, { consistentRead: true });
    if (!requestedPlayer) throw new PlayerIdentityError("player_not_found", 409, "This player is no longer available.");
    const membership = await this.planPlayerMembership(game, input.playerId, requestedPlayer.nickname, now);
    input = { ...input, playerId: membership.playerId };
    if (Buffer.byteLength(rosterSk(input.teamId, input.playerId)) > 1024) throw new PlayerIdentityError("player_roster_key_too_large", 400,
      "This legacy player profile cannot be assigned to this team. Ask the organiser for help.");
    const existingAssignments = await this.listGameRoster(input.gameId, { complete: true, consistentRead: true });
    const currentAssignmentsForPlayer = existingAssignments.filter(
      (assignment) => assignment.playerId === input.playerId,
    );
    const existingAssignment = currentAssignmentsForPlayer.find(
      (assignment) => assignment.teamId === input.teamId,
    );
    if (existingAssignment && await this.getGamePlayer(input.gameId, input.playerId)) {
      return existingAssignment;
    }
    const payload = {
      gameId: input.gameId,
      teamId: input.teamId,
      playerId: input.playerId,
    };
    const existingGamePlayer = await this.getEntity(
      gamePk(input.gameId),
      gamePlayerSk(input.playerId),
      { consistentRead: true },
    );
    const linkPayload = {
      gameId: input.gameId,
      playerId: input.playerId,
    };
    const transactionItems: TransactWriteItem[] = [
      ...membership.actions,
      this.buildGameConditionCheck(input.gameId, gameItem),
      ...currentAssignmentsForPlayer.filter(assignment => assignment.teamId !== input.teamId).map((assignment) => ({
        Delete: {
          TableName: this.tableName,
          Key: {
            pk: { S: gamePk(input.gameId) },
            sk: { S: rosterSk(assignment.teamId, assignment.playerId) },
          },
        },
      })),
      {
        Put: {
          TableName: this.tableName,
          Item: buildItemWithTimestamps(
            gamePk(input.gameId),
            gamePlayerSk(input.playerId),
            ENTITY_TYPE.gamePlayer,
            linkPayload,
            existingGamePlayer?.createdAt ?? now,
            now,
          ),
        },
      },
      {
        Put: {
          TableName: this.tableName,
          Item: buildItem(
            gamePk(input.gameId),
            rosterSk(input.teamId, input.playerId),
            ENTITY_TYPE.roster,
            payload,
            now,
          ),
        },
      },
    ];

    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: boundedIdentityTransaction(transactionItems),
        }),
      );
    } catch (error) {
      if (isConditionalWriteFailure(error)) {
        throw new GameMutationStateError(
          "game_state_changed",
          `Game ${input.gameId} changed before the roster assignment could be saved. Reload and try again.`,
        );
      }

      throw error;
    }

    return withTimestamps(payload, now, now);
  }

  async listGameRoster(gameId: string, options: { complete?: boolean; consistentRead?: boolean } = {}): Promise<RosterAssignmentRecord[]> {
    requireNonEmpty("gameId", gameId);
    const items = options.complete
      ? await this.queryCompleteGameRoster(gameId, "ROSTER#", options)
      : await this.queryByPrefix(gamePk(gameId), "ROSTER#", options);

    return items
      .filter((item) => item.entityType === ENTITY_TYPE.roster)
      .map((item) =>
        withTimestamps(
          item.data as Omit<RosterAssignmentRecord, "createdAt" | "updatedAt">,
          item.createdAt,
          item.updatedAt,
        ),
      );
  }

  private async readGoalTeamStates(
    gameId: string,
    options: { consistentRead?: boolean } = {},
  ): Promise<{
    teams: GameTeamRecord[];
    teamStatesById: Map<TeamId, { record: GameTeamRecord; rawData: string }>;
  }> {
    const teamItems = await this.queryByPrefix(gamePk(gameId), "TEAM#", options);
    const teamStates = teamItems
      .filter((item) => item.entityType === ENTITY_TYPE.gameTeam)
      .map((item) => ({
        record: withTimestamps(
          normalizeGameTeamPayload(item.data),
          item.createdAt,
          item.updatedAt,
        ),
        rawData: item.rawData,
      }));

    return {
      teams: sortGameTeams(teamStates.map((teamState) => teamState.record)),
      teamStatesById: new Map(teamStates.map((teamState) => [teamState.record.teamId, teamState])),
    };
  }

  private validateGoalRules(
    input: {
      gameId: string;
      scoringTeamId: TeamId | null;
      concedingTeamId: TeamId;
      scorerPlayerId: string;
      assistPlayerIds: string[];
      ownGoal: boolean;
    },
    teams: GameTeamRecord[],
    roster: RosterAssignmentRecord[],
    errorKind: GoalRuleErrorKind,
    previousGoal?: GoalEventRecord,
  ): void {
    requireGoalTeamId(input.concedingTeamId, "concedingTeamId", errorKind);
    if (input.scoringTeamId !== null) {
      requireGoalTeamId(input.scoringTeamId, "scoringTeamId", errorKind);
    }

    try {
      validateAssistPlayerIds(input.scorerPlayerId, input.assistPlayerIds);
    } catch (error) {
      throw goalRuleError(
        errorKind,
        "invalid_assists",
        400,
        error instanceof Error ? error.message : "Assist player IDs are invalid.",
      );
    }

    if (input.ownGoal && input.scoringTeamId !== null) {
      throw goalRuleError(
        errorKind,
        "own_goal_scoring_team",
        400,
        "ownGoal=true requires scoringTeamId to be null.",
      );
    }

    if (!input.ownGoal && input.scoringTeamId === null) {
      throw goalRuleError(
        errorKind,
        "scoring_team_required",
        400,
        "scoringTeamId is required when ownGoal=false.",
      );
    }

    if (!input.ownGoal && input.scoringTeamId === input.concedingTeamId) {
      throw goalRuleError(
        errorKind,
        "same_team_goal",
        400,
        "scoringTeamId and concedingTeamId must be different for a standard goal.",
      );
    }

    const teamsById = new Map(teams.map((team) => [team.teamId, team]));
    const concedingTeam = teamsById.get(input.concedingTeamId);
    if (!concedingTeam) {
      throw goalRuleError(
        errorKind,
        "invalid_conceding_team",
        400,
        "concedingTeamId must be an active team for this game.",
      );
    }

    const scoringTeam = input.scoringTeamId ? teamsById.get(input.scoringTeamId) : null;
    if (!input.ownGoal && !scoringTeam) {
      throw goalRuleError(
        errorKind,
        "invalid_scoring_team",
        400,
        "scoringTeamId must be an active team for this game.",
      );
    }

    const rosterByPlayerId = new Map(roster.map((assignment) => [assignment.playerId, assignment]));
    const scorerRoster = rosterByPlayerId.get(input.scorerPlayerId);
    const preservesOriginalScorerContext =
      errorKind === "correction" &&
      previousGoal !== undefined &&
      input.scorerPlayerId === previousGoal.scorerPlayerId &&
      input.ownGoal === previousGoal.ownGoal &&
      input.scoringTeamId === previousGoal.scoringTeamId &&
      input.concedingTeamId === previousGoal.concedingTeamId;
    if (!scorerRoster && !preservesOriginalScorerContext) {
      throw goalRuleError(
        errorKind,
        "scorer_not_rostered",
        400,
        "Scorer must be rostered in this game.",
      );
    }

    if (
      scorerRoster &&
      !preservesOriginalScorerContext &&
      !input.ownGoal &&
      scorerRoster.teamId !== input.scoringTeamId
    ) {
      throw goalRuleError(
        errorKind,
        "scorer_not_on_scoring_team",
        400,
        "Scorer must be rostered on the scoring team for a standard goal.",
      );
    }

    if (
      scorerRoster &&
      !preservesOriginalScorerContext &&
      input.ownGoal &&
      scorerRoster.teamId !== input.concedingTeamId
    ) {
      throw goalRuleError(
        errorKind,
        "scorer_not_on_conceding_team",
        400,
        "Own-goal scorer must be rostered on the conceding team.",
      );
    }

    for (const assistPlayerId of input.assistPlayerIds) {
      if (!rosterByPlayerId.has(assistPlayerId)) {
        throw goalRuleError(
          errorKind,
          "assist_not_rostered",
          400,
          "Assist players must be rostered in this game.",
        );
      }
    }
  }

  private recomputeTeamsFromGoals(
    gameId: string,
    teams: GameTeamRecord[],
    timeline: GoalEventRecord[],
    now: string,
  ): GameTeamRecord[] {
    const countsByTeamId = new Map<TeamId, { scored: number; conceded: number }>();
    for (const team of teams) {
      countsByTeamId.set(team.teamId, { scored: 0, conceded: 0 });
    }

    for (const goal of timeline) {
      if (!goal.ownGoal && goal.scoringTeamId) {
        const scoringCounts = countsByTeamId.get(goal.scoringTeamId);
        if (scoringCounts) {
          scoringCounts.scored += 1;
        }
      }

      const concedingCounts = countsByTeamId.get(goal.concedingTeamId);
      if (concedingCounts) {
        concedingCounts.conceded += 1;
      }
    }

    return sortGameTeams(
      teams.map((team) => {
        const counts = countsByTeamId.get(team.teamId) ?? { scored: 0, conceded: 0 };
        const changed = team.scored !== counts.scored || team.conceded !== counts.conceded;
        return {
          ...team,
          scored: counts.scored,
          conceded: counts.conceded,
          updatedAt: changed ? now : team.updatedAt,
        };
      }),
    );
  }

  private async findGoalByEventId(
    gameId: string,
    eventId: string,
    options: { consistentRead?: boolean } = {},
  ): Promise<{ goal: GoalEventRecord; sk: string; stored: StoredEntity<unknown> } | null> {
    const marker = await this.getEntity(gamePk(gameId), goalEventIdSk(eventId), options);
    const markerGoalSk =
      marker?.entityType === ENTITY_TYPE.goalEventId &&
      typeof (marker.data as { goalSk?: unknown }).goalSk === "string"
        ? (marker.data as { goalSk: string }).goalSk
        : null;

    if (markerGoalSk) {
      const stored = await this.getEntity(gamePk(gameId), markerGoalSk, options);
      if (stored?.entityType === ENTITY_TYPE.goal) {
        return {
          goal: withTimestamps(
            normalizeGoalEventPayload(stored.data),
            stored.createdAt,
            stored.updatedAt,
          ),
          sk: stored.sk,
          stored,
        };
      }
    }

    const goalItems = await this.queryByPrefix(gamePk(gameId), "GOAL#", options);
    const stored = goalItems.find(
      (item) =>
        item.entityType === ENTITY_TYPE.goal &&
        normalizeGoalEventPayload(item.data).eventId === eventId,
    );

    if (!stored) {
      return null;
    }

    return {
      goal: withTimestamps(normalizeGoalEventPayload(stored.data), stored.createdAt, stored.updatedAt),
      sk: stored.sk,
      stored,
    };
  }

  private async getGoalState(
    gameId: string,
    options: { consistentRead?: boolean } = {},
  ): Promise<{ state: GoalStateRecord; rawData: string } | null> {
    const stored = await this.getEntity(gamePk(gameId), goalStateSk(), options);
    if (!stored || stored.entityType !== ENTITY_TYPE.goalState) {
      return null;
    }

    return {
      state: withTimestamps(
        normalizeGoalStatePayload(stored.data),
        stored.createdAt,
        stored.updatedAt,
      ),
      rawData: stored.rawData,
    };
  }

  private buildGoalStateWrite(
    gameId: string,
    latest: GoalEventRecord | null,
    latestGoalSk: string | null,
    now: string,
    existing: { state: GoalStateRecord; rawData: string } | null,
  ) {
    const payload = {
      gameId,
      latestEventId: latest?.eventId ?? null,
      latestGoalSk,
      revision: (existing?.state.revision ?? 0) + 1,
    };
    const basePut = {
      TableName: this.tableName,
      Item: buildItemWithTimestamps(
        gamePk(gameId),
        goalStateSk(),
        ENTITY_TYPE.goalState,
        payload,
        existing?.state.createdAt ?? now,
        now,
      ),
    };

    if (!existing) {
      return {
        Put: {
          ...basePut,
          ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        },
      };
    }

    return {
      Put: {
        ...basePut,
        ConditionExpression: "#updatedAt = :expectedGoalStateUpdatedAt AND #data = :expectedGoalStateData",
        ExpressionAttributeNames: {
          "#updatedAt": "updatedAt",
          "#data": "data",
        },
        ExpressionAttributeValues: {
          ":expectedGoalStateUpdatedAt": { S: existing.state.updatedAt },
          ":expectedGoalStateData": { S: existing.rawData },
        },
      },
    };
  }

  private buildGamePutTransactionItem(input: {
    game: Omit<GameRecord, "createdAt" | "updatedAt">;
    stored: StoredEntity<unknown>;
    now: string;
  }) {
    return {
      Put: {
        TableName: this.tableName,
        Item: buildItemWithTimestamps(
          gamePk(input.game.gameId),
          metadataSk(),
          ENTITY_TYPE.game,
          input.game,
          input.stored.createdAt,
          input.now,
        ),
        ConditionExpression: "#updatedAt = :expectedGameUpdatedAt AND #data = :expectedGameData",
        ExpressionAttributeNames: {
          "#updatedAt": "updatedAt",
          "#data": "data",
        },
        ExpressionAttributeValues: {
          ":expectedGameUpdatedAt": { S: input.stored.updatedAt },
          ":expectedGameData": { S: input.stored.rawData },
        },
      },
    };
  }

  private buildGameConditionCheck(gameId: string, stored: StoredEntity<unknown>) {
    return {
      ConditionCheck: {
        TableName: this.tableName,
        Key: {
          pk: { S: gamePk(gameId) },
          sk: { S: metadataSk() },
        },
        ConditionExpression: "#updatedAt = :expectedGameUpdatedAt AND #data = :expectedGameData",
        ExpressionAttributeNames: {
          "#updatedAt": "updatedAt",
          "#data": "data",
        },
        ExpressionAttributeValues: {
          ":expectedGameUpdatedAt": { S: stored.updatedAt },
          ":expectedGameData": { S: stored.rawData },
        },
      },
    };
  }

  private async readGameForMutation(input: {
    gameId: string;
    allowFinished?: boolean;
    finishedMessage: string;
    changedMessage: string;
  }): Promise<{ item: StoredEntity<unknown>; game: Omit<GameRecord, "createdAt" | "updatedAt"> }> {
    const gameItem = await this.readMutableGameEntity(input.gameId);
    if (!gameItem || gameItem.entityType !== ENTITY_TYPE.game) {
      throw new GameMutationStateError("game_state_changed", input.changedMessage);
    }

    const game = normalizeGamePayload(gameItem.data);
    if (game.status === "finished" && input.allowFinished !== true) {
      throw new GameMutationStateError("game_finished", input.finishedMessage);
    }

    return { item: gameItem, game };
  }

  private async readMutableGameEntity(gameId: string): Promise<StoredEntity<unknown> | null> {
    const gameItem = await this.getEntity(gamePk(gameId), metadataSk(), { consistentRead: true });
    if (!gameItem || gameItem.entityType !== ENTITY_TYPE.game) {
      return null;
    }

    const originalGame = normalizeGamePayload(gameItem.data);
    const repairedGame = await this.repairLegacyGameJoinCode(gameItem);
    if (
      repairedGame.updatedAt === gameItem.updatedAt &&
      normalizeJoinCode(repairedGame.joinCode) === normalizeJoinCode(originalGame.joinCode)
    ) {
      return gameItem;
    }

    const repairedItem = await this.getEntity(gamePk(gameId), metadataSk(), { consistentRead: true });
    return repairedItem?.entityType === ENTITY_TYPE.game ? repairedItem : null;
  }

  private buildTeamConditionChecks(
    teams: GameTeamRecord[],
    originalTeamStatesById: Map<TeamId, { record: GameTeamRecord; rawData: string }>,
  ) {
    return teams.map((team) => {
      const original = originalTeamStatesById.get(team.teamId);
      if (!original) {
        throw new GameTimerTransitionError(
          "teams_not_ready",
          "All three game teams must exist before finishing the game.",
        );
      }

      return {
        ConditionCheck: {
          TableName: this.tableName,
          Key: {
            pk: { S: gamePk(team.gameId) },
            sk: { S: teamSk(team.teamId) },
          },
          ConditionExpression: "#updatedAt = :expectedUpdatedAt AND #data = :expectedData",
          ExpressionAttributeNames: {
            "#updatedAt": "updatedAt",
            "#data": "data",
          },
          ExpressionAttributeValues: {
            ":expectedUpdatedAt": { S: original.record.updatedAt },
            ":expectedData": { S: original.rawData },
          },
        },
      };
    });
  }

  private buildGoalAuditRecord(input: {
    gameId: string;
    eventId: string;
    actorUserId: string;
    action: GoalAuditAction;
    before: GoalEventRecord | null;
    after: GoalEventRecord | null;
    now: string;
  }): GoalAuditRecord {
    return {
      auditId: randomUUID(),
      gameId: input.gameId,
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      action: input.action,
      before: input.before ? goalAuditSnapshot(input.before) : null,
      after: input.after ? goalAuditSnapshot(input.after) : null,
      createdAt: input.now,
      updatedAt: input.now,
    };
  }

  private buildTeamPutTransactionItems(
    teams: GameTeamRecord[],
    originalTeamStatesById: Map<TeamId, { record: GameTeamRecord; rawData: string }>,
    now: string,
  ) {
    return teams.map((team) => {
      const original = originalTeamStatesById.get(team.teamId);
      if (!original) {
        throw new GoalCorrectionError(
          "scoreboard_state_changed",
          409,
          "Scoreboard changed while correcting this goal. Reload the game and try again.",
        );
      }

      return {
        Put: {
          TableName: this.tableName,
          Item: buildItemWithTimestamps(
            gamePk(team.gameId),
            teamSk(team.teamId),
            ENTITY_TYPE.gameTeam,
            {
              gameId: team.gameId,
              teamId: team.teamId,
              name: team.name,
              color: team.color,
              scored: team.scored,
              conceded: team.conceded,
            },
            team.createdAt,
            team.updatedAt === original.record.updatedAt ? original.record.updatedAt : now,
          ),
          ConditionExpression: "#updatedAt = :expectedUpdatedAt AND #data = :expectedData",
          ExpressionAttributeNames: {
            "#updatedAt": "updatedAt",
            "#data": "data",
          },
          ExpressionAttributeValues: {
            ":expectedUpdatedAt": { S: original.record.updatedAt },
            ":expectedData": { S: original.rawData },
          },
        },
      };
    });
  }

  private buildGoalAuditPut(audit: GoalAuditRecord) {
    return {
      Put: {
        TableName: this.tableName,
        Item: buildItemWithTimestamps(
          gamePk(audit.gameId),
          goalAuditSk(audit.createdAt, audit.auditId),
          ENTITY_TYPE.goalAudit,
          {
            auditId: audit.auditId,
            gameId: audit.gameId,
            eventId: audit.eventId,
            actorUserId: audit.actorUserId,
            action: audit.action,
            before: audit.before,
            after: audit.after,
          },
          audit.createdAt,
          audit.updatedAt,
        ),
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      },
    };
  }

  private normalizeCorrectionOperation(input: {
    operationId?: string | null;
    operationRequestHash?: string | null;
  }): { operationId: string; requestHash: string } | null {
    const operationId = input.operationId?.trim() ?? "";
    const requestHash = input.operationRequestHash?.trim() ?? "";
    if (!operationId && !requestHash) {
      return null;
    }

    if (!operationId || !requestHash) {
      throw new GoalCorrectionError(
        "invalid_correction_operation",
        400,
        "Correction operation id and request hash must be provided together.",
      );
    }

    return {
      operationId,
      requestHash,
    };
  }

  private buildGoalCorrectionOperationPut(input: {
    gameId: string;
    eventId: string;
    operationId: string;
    requestHash: string;
    action: Extract<GoalAuditAction, "goal_updated" | "goal_deleted" | "goal_undo_last">;
    result: GoalCorrectionOperationRecord["result"];
    now: string;
  }) {
    return {
      Put: {
        TableName: this.tableName,
        Item: buildItem(
          gamePk(input.gameId),
          goalCorrectionOperationSk(input.operationId),
          ENTITY_TYPE.goalCorrectionOperation,
          {
            gameId: input.gameId,
            eventId: input.eventId,
            operationId: input.operationId,
            requestHash: input.requestHash,
            action: input.action,
            result: input.result,
          },
          input.now,
        ),
        ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      },
    };
  }

  private async getGoalCorrectionOperation(
    gameId: string,
    operationId: string,
  ): Promise<GoalCorrectionOperationRecord | null> {
    const stored = await this.getEntity(
      gamePk(gameId),
      goalCorrectionOperationSk(operationId),
      { consistentRead: true },
    );
    if (!stored || stored.entityType !== ENTITY_TYPE.goalCorrectionOperation) {
      return null;
    }

    return withTimestamps(
      normalizeGoalCorrectionOperationPayload(stored.data),
      stored.createdAt,
      stored.updatedAt,
    );
  }

  private async replayGoalCorrectionOperation<T extends UpdateGoalResult | DeleteGoalResult>(
    gameId: string,
    operation: { operationId: string; requestHash: string } | null,
  ): Promise<T | null> {
    if (!operation) {
      return null;
    }

    const existingOperation = await this.getGoalCorrectionOperation(gameId, operation.operationId);
    if (!existingOperation) {
      return null;
    }

    if (existingOperation.requestHash !== operation.requestHash) {
      throw new GoalCorrectionError(
        "idempotency_conflict",
        409,
        "Correction operation id has already been used with a different request payload.",
      );
    }

    return existingOperation.result as T;
  }

  private async originalGoalPlayerIds(gameId: string, scorerPlayerId: string, assistPlayerIds: string[]): Promise<{
    scorerPlayerId: string; assistPlayerIds: string[];
  }> {
    const roster = await this.listGameRoster(gameId, { complete: true, consistentRead: true });
    const originalIds = new Set(roster.map(entry => entry.playerId));
    const mapped = new Map<string, string>();
    for (const id of new Set([scorerPlayerId, ...assistPlayerIds])) {
      // Historical IDs already in this game remain exact targets. A canonical
      // picker value may instead refer to a different underlying registration.
      if (originalIds.has(id)) { mapped.set(id, id); continue; }
      const profile = await this.getPlayer(id, { consistentRead: true });
      if (!profile) { mapped.set(id, id); continue; } // Existing validation owns unknown-player errors.
      const identity = await this.identities.resolve(id, profile.nickname);
      const original = await this.identities.registeredOriginal(identity, gameId);
      mapped.set(id, original ?? id);
    }
    return { scorerPlayerId: mapped.get(scorerPlayerId)!, assistPlayerIds: assistPlayerIds.map(id => mapped.get(id)!) };
  }

  async createGoal(input: CreateGoalInput): Promise<CreateGoalResult | null> {
    requireNonEmpty("gameId", input.gameId);
    requireNonEmpty("eventId", input.eventId);
    requireNonEmpty("actorUserId", input.actorUserId);
    requireNonEmpty("concedingTeamId", input.concedingTeamId);
    requireNonEmpty("scorerPlayerId", input.scorerPlayerId);
    input = { ...input, ...await this.originalGoalPlayerIds(input.gameId, input.scorerPlayerId, input.assistPlayerIds) };
    requireTeamId(input.concedingTeamId, "concedingTeamId");
    if (input.scoringTeamId !== null) {
      requireTeamId(input.scoringTeamId, "scoringTeamId");
    }

    try {
      validateAssistPlayerIds(input.scorerPlayerId, input.assistPlayerIds);
    } catch (error) {
      throw new GoalCreationError(
        "invalid_assists",
        400,
        error instanceof Error ? error.message : "Assist player IDs are invalid.",
      );
    }

    if (input.ownGoal && input.scoringTeamId !== null) {
      throw new GoalCreationError(
        "own_goal_scoring_team",
        400,
        "ownGoal=true requires scoringTeamId to be null.",
      );
    }

    if (!input.ownGoal && input.scoringTeamId === null) {
      throw new GoalCreationError(
        "scoring_team_required",
        400,
        "scoringTeamId is required when ownGoal=false.",
      );
    }

    if (!input.ownGoal && input.scoringTeamId === input.concedingTeamId) {
      throw new GoalCreationError(
        "same_team_goal",
        400,
        "scoringTeamId and concedingTeamId must be different for a standard goal.",
      );
    }

    const gameItem = await this.getEntity(gamePk(input.gameId), metadataSk());
    if (!gameItem || gameItem.entityType !== ENTITY_TYPE.game) {
      return null;
    }

    const game = normalizeGamePayload(gameItem.data);
    const allowFinished = game.status === "finished" && input.allowFinished === true;
    if (game.status === "finished" && !allowFinished) {
      throw new GoalCreationError(
        "game_finished",
        409,
        "Cannot create a goal after the game is finished.",
      );
    }

    const activeThird = game.thirds.find((third) => third.startedAt && !third.finishedAt);
    const sortedThirds = [...game.thirds].sort((left, right) => left.third - right.third);
    const finishedCorrectionThird = allowFinished
      ? sortedThirds.filter((third) => third.finishedAt).at(-1) ?? sortedThirds.at(-1)
      : null;
    const goalThird = activeThird ?? finishedCorrectionThird;
    if (!goalThird || (!activeThird?.startedAt && !allowFinished)) {
      throw new GoalCreationError(
        "no_active_third",
        409,
        allowFinished
          ? "A finished-game correction needs at least one configured third."
          : "A goal can only be created while a third is running.",
      );
    }

    const teamItems = await this.queryByPrefix(gamePk(input.gameId), "TEAM#", {
      consistentRead: true,
    });
    const teamStates = teamItems
      .filter((item) => item.entityType === ENTITY_TYPE.gameTeam)
      .map((item) => ({
        record: withTimestamps(
          normalizeGameTeamPayload(item.data),
          item.createdAt,
          item.updatedAt,
        ),
        rawData: item.rawData,
      }));
    const teams = sortGameTeams(teamStates.map((teamState) => teamState.record));
    const teamsById = new Map(teams.map((team) => [team.teamId, team]));
    const teamStatesById = new Map(teamStates.map((teamState) => [teamState.record.teamId, teamState]));
    const concedingTeam = teamsById.get(input.concedingTeamId);
    if (!concedingTeam) {
      throw new GoalCreationError(
        "invalid_conceding_team",
        400,
        "concedingTeamId must be an active team for this game.",
      );
    }

    const scoringTeam = input.scoringTeamId ? teamsById.get(input.scoringTeamId) : null;
    if (!input.ownGoal && !scoringTeam) {
      throw new GoalCreationError(
        "invalid_scoring_team",
        400,
        "scoringTeamId must be an active team for this game.",
      );
    }

    const roster = await this.listGameRoster(input.gameId);
    const rosterByPlayerId = new Map(roster.map((assignment) => [assignment.playerId, assignment]));
    const scorerRoster = rosterByPlayerId.get(input.scorerPlayerId);
    if (!scorerRoster) {
      throw new GoalCreationError(
        "scorer_not_rostered",
        400,
        "Scorer must be rostered in this game.",
      );
    }

    if (!input.ownGoal && scorerRoster.teamId !== input.scoringTeamId) {
      throw new GoalCreationError(
        "scorer_not_on_scoring_team",
        400,
        "Scorer must be rostered on the scoring team for a standard goal.",
      );
    }

    if (input.ownGoal && scorerRoster.teamId !== input.concedingTeamId) {
      throw new GoalCreationError(
        "scorer_not_on_conceding_team",
        400,
        "Own-goal scorer must be rostered on the conceding team.",
      );
    }

    for (const assistPlayerId of input.assistPlayerIds) {
      if (!rosterByPlayerId.has(assistPlayerId)) {
        throw new GoalCreationError(
          "assist_not_rostered",
          400,
          "Assist players must be rostered in this game.",
        );
      }
    }

    const now = this.clock.now();
    const startedAtMs = activeThird?.startedAt ? Date.parse(activeThird.startedAt) : NaN;
    const nowMs = Date.parse(now);
    const elapsedSeconds = allowFinished
      ? game.thirdLengthMinutes * 60
      : Number.isFinite(startedAtMs) && Number.isFinite(nowMs)
        ? Math.max(0, Math.floor((nowMs - startedAtMs) / 1000))
        : 0;
    const display = formatThirdDisplayTime(elapsedSeconds, game.thirdLengthMinutes);
    const thirdMinute = allowFinished
      ? game.thirdLengthMinutes
      : Math.min(
          game.thirdLengthMinutes,
          Math.floor(display.elapsedSeconds / 60) + 1,
        );
    const gameMinute = (goalThird.third - 1) * game.thirdLengthMinutes + thirdMinute;
    const payload = {
      gameId: input.gameId,
      eventId: input.eventId,
      third: goalThird.third,
      thirdMinute,
      gameMinute,
      elapsedSeconds: display.elapsedSeconds,
      stoppageMinute: display.stoppageMinute,
      displayTime: display.displayTime,
      scoringTeamId: input.scoringTeamId,
      concedingTeamId: input.concedingTeamId,
      scorerPlayerId: input.scorerPlayerId,
      assistPlayerIds: input.assistPlayerIds,
      ownGoal: input.ownGoal,
    };

    const nextTeams = teams.map((team) => {
      const scored = !input.ownGoal && team.teamId === input.scoringTeamId
        ? team.scored + 1
        : team.scored;
      const conceded = team.teamId === input.concedingTeamId
        ? team.conceded + 1
        : team.conceded;

      return {
        ...team,
        scored,
        conceded,
        updatedAt:
          scored !== team.scored || conceded !== team.conceded
            ? now
            : team.updatedAt,
      };
    });
    const changedTeams = nextTeams.filter((team) => {
      const original = teamsById.get(team.teamId);
      return original ? team.scored !== original.scored || team.conceded !== original.conceded : false;
    });
    const goalSortKey = goalSk(goalThird.third, gameMinute, display.elapsedSeconds, input.eventId);
    const goalEventIdKey = goalEventIdSk(input.eventId);
    const goal = withTimestamps(payload, now, now);
    const existingGoalState = await this.getGoalState(input.gameId, { consistentRead: true });
    const audit = this.buildGoalAuditRecord({
      gameId: input.gameId,
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      action: "goal_created",
      before: null,
      after: goal,
      now,
    });
    const updatedFinishedGame =
      game.status === "finished"
        ? {
            ...game,
            finishedAt: game.finishedAt ?? now,
            result: buildGameResult(nextTeams, now),
          }
        : null;

    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            ...(updatedFinishedGame
              ? [
                  this.buildGamePutTransactionItem({
                    game: updatedFinishedGame,
                    stored: gameItem,
                    now,
                  }),
                ]
              : [this.buildGameConditionCheck(input.gameId, gameItem)]),
            ...changedTeams.map((team) => {
              const original = teamStatesById.get(team.teamId);
              if (!original) {
                throw new GoalCreationError(
                  "scoreboard_state_changed",
                  409,
                  "Scoreboard changed while creating this goal. Reload the game and try again.",
                );
              }

              return {
                Put: {
                  TableName: this.tableName,
                  Item: buildItemWithTimestamps(
                    gamePk(team.gameId),
                    teamSk(team.teamId),
                    ENTITY_TYPE.gameTeam,
                    {
                      gameId: team.gameId,
                      teamId: team.teamId,
                      name: team.name,
                      color: team.color,
                      scored: team.scored,
                      conceded: team.conceded,
                    },
                    team.createdAt,
                    now,
                  ),
                  ConditionExpression: "#updatedAt = :expectedUpdatedAt AND #data = :expectedData",
                  ExpressionAttributeNames: {
                    "#updatedAt": "updatedAt",
                    "#data": "data",
                  },
                  ExpressionAttributeValues: {
                    ":expectedUpdatedAt": { S: original.record.updatedAt },
                    ":expectedData": { S: original.rawData },
                  },
                },
              };
            }),
            {
              Put: {
                TableName: this.tableName,
                Item: buildItem(
                  gamePk(input.gameId),
                  goalSortKey,
                  ENTITY_TYPE.goal,
                  payload,
                  now,
                ),
                ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: buildItem(
                  gamePk(input.gameId),
                  goalEventIdKey,
                  ENTITY_TYPE.goalEventId,
                  {
                    gameId: input.gameId,
                    eventId: input.eventId,
                    goalSk: goalSortKey,
                  },
                  now,
                ),
                ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
              },
            },
            this.buildGoalStateWrite(input.gameId, goal, goalSortKey, now, existingGoalState),
            this.buildGoalAuditPut(audit),
          ],
        }),
      );
    } catch (error) {
      if (!isConditionalWriteFailure(error)) {
        throw error;
      }

      const [existingGoal, existingGoalEventId] = await Promise.all([
        this.getEntity(gamePk(input.gameId), goalSortKey),
        this.getEntity(gamePk(input.gameId), goalEventIdKey),
      ]);
      if (
        existingGoal?.entityType === ENTITY_TYPE.goal ||
        existingGoalEventId?.entityType === ENTITY_TYPE.goalEventId
      ) {
        throw new GoalCreationError(
          "goal_already_created",
          409,
          "Goal event has already been created for this request.",
        );
      }

      throw new GoalCreationError(
        "scoreboard_state_changed",
        409,
        "Scoreboard changed while creating this goal, or game/goal state changed. Reload the game and try again.",
      );
    }

    const persistedTimeline = await this.listGoalEventsForWrite(input.gameId);

    return {
      goal,
      scoreboard: {
        teams: sortGameTeams(nextTeams),
      },
      timeline: persistedTimeline,
    };
  }

  async listGoalEvents(gameId: string): Promise<GoalEventRecord[]> {
    return this.listGoalEventsWithConsistency(gameId, true);
  }

  private async listGoalEventsForWrite(gameId: string): Promise<GoalEventRecord[]> {
    return this.listGoalEventsWithConsistency(gameId, true);
  }

  private async listGoalEventsWithConsistency(
    gameId: string,
    consistentRead: boolean,
  ): Promise<GoalEventRecord[]> {
    requireNonEmpty("gameId", gameId);
    const items = await this.queryByPrefix(gamePk(gameId), "GOAL#", { consistentRead });

    return items
      .filter((item) => item.entityType === ENTITY_TYPE.goal)
      .map((item) =>
        withTimestamps(
          normalizeGoalEventPayload(item.data),
          item.createdAt,
          item.updatedAt,
        ),
      )
      .sort(compareGoalEvents);
  }

  async listGoalAuditEntries(gameId: string): Promise<GoalAuditRecord[]> {
    requireNonEmpty("gameId", gameId);
    const items = await this.queryByPrefix(gamePk(gameId), "AUDIT#GOAL#");

    return items
      .filter((item) => item.entityType === ENTITY_TYPE.goalAudit)
      .map((item) =>
        withTimestamps(
          normalizeGoalAuditPayload(item.data),
          item.createdAt,
          item.updatedAt,
        ),
      );
  }

  async updateGoal(input: UpdateGoalInput): Promise<UpdateGoalResult | null> {
    requireNonEmpty("gameId", input.gameId);
    requireNonEmpty("eventId", input.eventId);
    requireNonEmpty("actorUserId", input.actorUserId);
    const operation = this.normalizeCorrectionOperation(input);
    const replayed = await this.replayGoalCorrectionOperation<UpdateGoalResult>(
      input.gameId,
      operation,
    );
    if (replayed) {
      return replayed;
    }

    const gameItem = await this.readMutableGameEntity(input.gameId);
    if (!gameItem || gameItem.entityType !== ENTITY_TYPE.game) {
      return null;
    }
    const game = normalizeGamePayload(gameItem.data);
    if (game.status === "finished" && input.allowFinished !== true) {
      throw new GoalCorrectionError(
        "game_finished",
        409,
        `Game ${input.gameId} is finished. Admin role is required to mutate finished games.`,
      );
    }

    const existing = await this.findGoalByEventId(
      input.gameId,
      input.eventId,
      { consistentRead: true },
    );
    if (!existing) {
      return null;
    }

    const previousGoal = existing.goal;
    const requestedGoal = {
      ...previousGoal,
      scoringTeamId:
        input.scoringTeamId === undefined ? previousGoal.scoringTeamId : input.scoringTeamId,
      concedingTeamId: input.concedingTeamId ?? previousGoal.concedingTeamId,
      scorerPlayerId: input.scorerPlayerId ?? previousGoal.scorerPlayerId,
      assistPlayerIds: input.assistPlayerIds ?? previousGoal.assistPlayerIds,
      ownGoal: input.ownGoal ?? previousGoal.ownGoal,
    };
    // The immutable correction request fingerprint above is intentionally taken
    // before mapping; retries retain the request the caller actually submitted.
    const goal = { ...requestedGoal, ...await this.originalGoalPlayerIds(input.gameId,
      requestedGoal.scorerPlayerId, requestedGoal.assistPlayerIds) };
    const { teams, teamStatesById } = await this.readGoalTeamStates(
      input.gameId,
      { consistentRead: true },
    );
    const roster = await this.listGameRoster(input.gameId);
    this.validateGoalRules(goal, teams, roster, "correction", previousGoal);

    const now = this.clock.now();
    const updatedGoal = {
      ...goal,
      updatedAt: now,
    };
    const timeline = await this.listGoalEventsForWrite(input.gameId);
    const nextTimeline = timeline
      .map((entry) => (entry.eventId === input.eventId ? updatedGoal : entry))
      .sort(compareGoalEvents);
    const nextTeams = this.recomputeTeamsFromGoals(input.gameId, teams, nextTimeline, now);
    const latestAfter = latestGoalEvent(nextTimeline);
    const latestGoalSk = latestAfter
      ? goalSk(latestAfter.third, latestAfter.gameMinute, latestAfter.elapsedSeconds, latestAfter.eventId)
      : null;
    const existingGoalState = await this.getGoalState(input.gameId, { consistentRead: true });
    const audit = this.buildGoalAuditRecord({
      gameId: input.gameId,
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      action: "goal_updated",
      before: previousGoal,
      after: updatedGoal,
      now,
    });
    const result: UpdateGoalResult = {
      goal: updatedGoal,
      previousGoal,
      scoreboard: {
        teams: nextTeams,
      },
      timeline: nextTimeline,
      audit,
    };
    const updatedFinishedGame =
      game.status === "finished"
        ? {
            ...game,
            finishedAt: game.finishedAt ?? now,
            result: buildGameResult(nextTeams, now),
          }
        : null;

    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            ...this.buildTeamPutTransactionItems(nextTeams, teamStatesById, now),
            ...(updatedFinishedGame
              ? [
                  this.buildGamePutTransactionItem({
                    game: updatedFinishedGame,
                    stored: gameItem,
                    now,
                  }),
                ]
              : [this.buildGameConditionCheck(input.gameId, gameItem)]),
            {
              Put: {
                TableName: this.tableName,
                Item: buildItemWithTimestamps(
                  gamePk(input.gameId),
                  existing.sk,
                  ENTITY_TYPE.goal,
                  {
                    gameId: updatedGoal.gameId,
                    eventId: updatedGoal.eventId,
                    third: updatedGoal.third,
                    thirdMinute: updatedGoal.thirdMinute,
                    gameMinute: updatedGoal.gameMinute,
                    elapsedSeconds: updatedGoal.elapsedSeconds,
                    stoppageMinute: updatedGoal.stoppageMinute,
                    displayTime: updatedGoal.displayTime,
                    scoringTeamId: updatedGoal.scoringTeamId,
                    concedingTeamId: updatedGoal.concedingTeamId,
                    scorerPlayerId: updatedGoal.scorerPlayerId,
                    assistPlayerIds: updatedGoal.assistPlayerIds,
                    ownGoal: updatedGoal.ownGoal,
                  },
                  updatedGoal.createdAt,
                  now,
                ),
                ConditionExpression: "#updatedAt = :expectedGoalUpdatedAt AND #data = :expectedGoalData",
                ExpressionAttributeNames: {
                  "#updatedAt": "updatedAt",
                  "#data": "data",
                },
                ExpressionAttributeValues: {
                  ":expectedGoalUpdatedAt": { S: existing.goal.updatedAt },
                  ":expectedGoalData": { S: existing.stored.rawData },
                },
              },
            },
            this.buildGoalStateWrite(input.gameId, latestAfter, latestGoalSk, now, existingGoalState),
            this.buildGoalAuditPut(audit),
            ...(operation
              ? [
                  this.buildGoalCorrectionOperationPut({
                    gameId: input.gameId,
                    eventId: input.eventId,
                    operationId: operation.operationId,
                    requestHash: operation.requestHash,
                    action: "goal_updated",
                    result,
                    now,
                  }),
                ]
              : []),
          ],
        }),
      );
    } catch (error) {
      if (!isConditionalWriteFailure(error)) {
        throw error;
      }

      const replayedAfterConflict =
        await this.replayGoalCorrectionOperation<UpdateGoalResult>(input.gameId, operation);
      if (replayedAfterConflict) {
        return replayedAfterConflict;
      }

      throw new GoalCorrectionError(
        "goal_state_changed",
        409,
        "Goal or scoreboard state changed while updating this goal. Reload the game and try again.",
      );
    }

    return result;
  }

  async deleteGoal(input: DeleteGoalInput): Promise<DeleteGoalResult | null> {
    requireNonEmpty("gameId", input.gameId);
    requireNonEmpty("eventId", input.eventId);
    requireNonEmpty("actorUserId", input.actorUserId);
    const operation = this.normalizeCorrectionOperation(input);
    const replayed = await this.replayGoalCorrectionOperation<DeleteGoalResult>(
      input.gameId,
      operation,
    );
    if (replayed) {
      return replayed;
    }

    const gameItem = await this.readMutableGameEntity(input.gameId);
    if (!gameItem || gameItem.entityType !== ENTITY_TYPE.game) {
      return null;
    }
    const game = normalizeGamePayload(gameItem.data);
    if (game.status === "finished" && input.allowFinished !== true) {
      throw new GoalCorrectionError(
        "game_finished",
        409,
        `Game ${input.gameId} is finished. Admin role is required to mutate finished games.`,
      );
    }

    const existing = await this.findGoalByEventId(
      input.gameId,
      input.eventId,
      { consistentRead: true },
    );
    if (!existing) {
      return null;
    }

    const timeline = await this.listGoalEventsForWrite(input.gameId);
    const latestBefore = latestGoalEvent(timeline);
    const existingGoalState = await this.getGoalState(input.gameId, { consistentRead: true });
    if (
      input.expectedLatestEventId &&
      latestBefore?.eventId !== input.expectedLatestEventId
    ) {
      throw new GoalCorrectionError(
        "latest_goal_changed",
        409,
        "Latest goal changed before undo could be applied. Reload the game and try again.",
      );
    }

    if (
      input.expectedLatestEventId &&
      existingGoalState &&
      existingGoalState.state.latestEventId !== input.expectedLatestEventId
    ) {
      throw new GoalCorrectionError(
        "latest_goal_changed",
        409,
        "Latest goal changed before undo could be applied. Reload the game and try again.",
      );
    }

    if (input.action === "goal_undo_last" && latestBefore?.eventId !== input.eventId) {
      throw new GoalCorrectionError(
        "not_latest_goal",
        409,
        "Undo can only delete the current most recent goal.",
      );
    }

    const now = this.clock.now();
    const nextTimeline = timeline
      .filter((entry) => entry.eventId !== input.eventId)
      .sort(compareGoalEvents);
    const { teams, teamStatesById } = await this.readGoalTeamStates(
      input.gameId,
      { consistentRead: true },
    );
    const nextTeams = this.recomputeTeamsFromGoals(input.gameId, teams, nextTimeline, now);
    const latestAfter = latestGoalEvent(nextTimeline);
    const latestGoalSk = latestAfter
      ? goalSk(latestAfter.third, latestAfter.gameMinute, latestAfter.elapsedSeconds, latestAfter.eventId)
      : null;
    const action = input.action ?? "goal_deleted";
    const audit = this.buildGoalAuditRecord({
      gameId: input.gameId,
      eventId: input.eventId,
      actorUserId: input.actorUserId,
      action,
      before: existing.goal,
      after: null,
      now,
    });
    const result: DeleteGoalResult = {
      deletedGoal: existing.goal,
      scoreboard: {
        teams: nextTeams,
      },
      timeline: nextTimeline,
      audit,
    };
    const updatedFinishedGame =
      game.status === "finished"
        ? {
            ...game,
            finishedAt: game.finishedAt ?? now,
            result: buildGameResult(nextTeams, now),
          }
        : null;

    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: [
            ...this.buildTeamPutTransactionItems(nextTeams, teamStatesById, now),
            ...(updatedFinishedGame
              ? [
                  this.buildGamePutTransactionItem({
                    game: updatedFinishedGame,
                    stored: gameItem,
                    now,
                  }),
                ]
              : [this.buildGameConditionCheck(input.gameId, gameItem)]),
            {
              Delete: {
                TableName: this.tableName,
                Key: {
                  pk: { S: gamePk(input.gameId) },
                  sk: { S: existing.sk },
                },
                ConditionExpression: "#updatedAt = :expectedGoalUpdatedAt AND #data = :expectedGoalData",
                ExpressionAttributeNames: {
                  "#updatedAt": "updatedAt",
                  "#data": "data",
                },
                ExpressionAttributeValues: {
                  ":expectedGoalUpdatedAt": { S: existing.goal.updatedAt },
                  ":expectedGoalData": { S: existing.stored.rawData },
                },
              },
            },
            {
              Delete: {
                TableName: this.tableName,
                Key: {
                  pk: { S: gamePk(input.gameId) },
                  sk: { S: goalEventIdSk(input.eventId) },
                },
              },
            },
            this.buildGoalStateWrite(input.gameId, latestAfter, latestGoalSk, now, existingGoalState),
            this.buildGoalAuditPut(audit),
            ...(operation
              ? [
                  this.buildGoalCorrectionOperationPut({
                    gameId: input.gameId,
                    eventId: input.eventId,
                    operationId: operation.operationId,
                    requestHash: operation.requestHash,
                    action,
                    result,
                    now,
                  }),
                ]
              : []),
          ],
        }),
      );
    } catch (error) {
      if (!isConditionalWriteFailure(error)) {
        throw error;
      }

      const replayedAfterConflict =
        await this.replayGoalCorrectionOperation<DeleteGoalResult>(input.gameId, operation);
      if (replayedAfterConflict) {
        return replayedAfterConflict;
      }

      throw new GoalCorrectionError(
        "goal_state_changed",
        409,
        "Goal or scoreboard state changed while deleting this goal. Reload the game and try again.",
      );
    }

    return result;
  }

  async undoLastGoal(input: UndoLastGoalInput): Promise<DeleteGoalResult | null> {
    requireNonEmpty("gameId", input.gameId);
    requireNonEmpty("actorUserId", input.actorUserId);
    requireNonEmpty("expectedEventId", input.expectedEventId);
    const operation = this.normalizeCorrectionOperation(input);
    const replayed = await this.replayGoalCorrectionOperation<DeleteGoalResult>(
      input.gameId,
      operation,
    );
    if (replayed) {
      return replayed;
    }

    const timeline = await this.listGoalEventsForWrite(input.gameId);
    const latest = latestGoalEvent(timeline);
    if (!latest) {
      return null;
    }

    if (latest.eventId !== input.expectedEventId) {
      throw new GoalCorrectionError(
        "latest_goal_changed",
        409,
        "Latest goal changed before undo could be applied. Reload the game and try again.",
      );
    }

    return this.deleteGoal({
      gameId: input.gameId,
      eventId: latest.eventId,
      actorUserId: input.actorUserId,
      operationId: input.operationId,
      operationRequestHash: input.operationRequestHash,
      allowFinished: input.allowFinished,
      action: "goal_undo_last",
      expectedLatestEventId: input.expectedEventId,
    });
  }

  async getIdempotencyRecord(scope: string, key: string): Promise<IdempotencyRecord | null> {
    requireNonEmpty("scope", scope);
    requireNonEmpty("key", key);
    const item = await this.getEntity(idempotencyPk(scope, key), metadataSk(), {
      consistentRead: true,
    });

    if (!item || item.entityType !== ENTITY_TYPE.idempotency) {
      return null;
    }

    return withTimestamps(
      item.data as Omit<IdempotencyRecord, "createdAt" | "updatedAt">,
      item.createdAt,
      item.updatedAt,
    );
  }

  async createIdempotencyRecord(input: CreateIdempotencyRecordInput): Promise<boolean> {
    requireNonEmpty("scope", input.scope);
    requireNonEmpty("key", input.key);
    requireNonEmpty("requestHash", input.requestHash);
    requireNonEmpty("responseBody", input.responseBody);

    if (
      !Number.isInteger(input.responseStatusCode) ||
      input.responseStatusCode < 100 ||
      input.responseStatusCode > 599
    ) {
      throw new Error("responseStatusCode must be a valid HTTP status code.");
    }

    const now = this.clock.now();
    const payload = {
      scope: input.scope,
      key: input.key,
      requestHash: input.requestHash,
      responseStatusCode: input.responseStatusCode,
      responseBody: input.responseBody,
    };

    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: buildItem(
            idempotencyPk(input.scope, input.key),
            metadataSk(),
            ENTITY_TYPE.idempotency,
            payload,
            now,
          ),
          ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        }),
      );
      return true;
    } catch (error) {
      const awsError = error as { name?: string };
      if (awsError.name === "ConditionalCheckFailedException") {
        return false;
      }

      throw error;
    }
  }

  async completeIdempotencyRecord(input: CompleteIdempotencyRecordInput): Promise<boolean> {
    requireNonEmpty("scope", input.scope);
    requireNonEmpty("key", input.key);
    requireNonEmpty("requestHash", input.requestHash);
    requireNonEmpty("responseBody", input.responseBody);
    requireNonEmpty("expectedResponseBody", input.expectedResponseBody);

    if (
      !Number.isInteger(input.responseStatusCode) ||
      input.responseStatusCode < 100 ||
      input.responseStatusCode > 599
    ) {
      throw new Error("responseStatusCode must be a valid HTTP status code.");
    }
    if (
      !Number.isInteger(input.expectedResponseStatusCode) ||
      input.expectedResponseStatusCode < 100 ||
      input.expectedResponseStatusCode > 599
    ) {
      throw new Error("expectedResponseStatusCode must be a valid HTTP status code.");
    }

    const existing = await this.getIdempotencyRecord(input.scope, input.key);
    if (
      !existing ||
      existing.requestHash !== input.requestHash ||
      existing.responseStatusCode !== input.expectedResponseStatusCode ||
      existing.responseBody !== input.expectedResponseBody ||
      (input.expectedUpdatedAt !== undefined && existing.updatedAt !== input.expectedUpdatedAt)
    ) {
      return false;
    }

    const now = this.clock.now();
    const payload = {
      scope: input.scope,
      key: input.key,
      requestHash: input.requestHash,
      responseStatusCode: input.responseStatusCode,
      responseBody: input.responseBody,
    };
    const expectedPayload = {
      scope: input.scope,
      key: input.key,
      requestHash: input.requestHash,
      responseStatusCode: input.expectedResponseStatusCode,
      responseBody: input.expectedResponseBody,
    };

    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: buildItemWithTimestamps(
            idempotencyPk(input.scope, input.key),
            metadataSk(),
            ENTITY_TYPE.idempotency,
            payload,
            existing.createdAt,
            now,
          ),
          ConditionExpression:
            "attribute_exists(pk) AND attribute_exists(sk) AND #data = :expectedData" +
            (input.expectedUpdatedAt === undefined ? "" : " AND #updatedAt = :expectedUpdatedAt"),
          ExpressionAttributeNames: {
            "#data": "data",
            ...(input.expectedUpdatedAt === undefined ? {} : { "#updatedAt": "updatedAt" }),
          },
          ExpressionAttributeValues: {
            ":expectedData": { S: JSON.stringify(expectedPayload) },
            ...(input.expectedUpdatedAt === undefined
              ? {}
              : { ":expectedUpdatedAt": { S: input.expectedUpdatedAt } }),
          },
        }),
      );
      return true;
    } catch (error) {
      const awsError = error as { name?: string };
      if (awsError.name === "ConditionalCheckFailedException") {
        return false;
      }

      throw error;
    }
  }

  async deleteIdempotencyRecord(input: DeleteIdempotencyRecordInput): Promise<boolean> {
    requireNonEmpty("scope", input.scope);
    requireNonEmpty("key", input.key);
    requireNonEmpty("requestHash", input.requestHash);
    requireNonEmpty("responseBody", input.responseBody);
    if (
      !Number.isInteger(input.responseStatusCode) ||
      input.responseStatusCode < 100 ||
      input.responseStatusCode > 599
    ) {
      throw new Error("responseStatusCode must be a valid HTTP status code.");
    }

    const existing = await this.getIdempotencyRecord(input.scope, input.key);
    if (
      !existing ||
      existing.requestHash !== input.requestHash ||
      existing.responseStatusCode !== input.responseStatusCode ||
      existing.responseBody !== input.responseBody ||
      (input.updatedAt !== undefined && existing.updatedAt !== input.updatedAt)
    ) {
      return false;
    }

    const expectedPayload = {
      scope: input.scope,
      key: input.key,
      requestHash: input.requestHash,
      responseStatusCode: input.responseStatusCode,
      responseBody: input.responseBody,
    };

    try {
      await this.client.send(
        new DeleteItemCommand({
          TableName: this.tableName,
          Key: {
            pk: { S: idempotencyPk(input.scope, input.key) },
            sk: { S: metadataSk() },
          },
          ConditionExpression:
            "attribute_exists(pk) AND attribute_exists(sk) AND #data = :data" +
            (input.updatedAt === undefined ? "" : " AND #updatedAt = :updatedAt"),
          ExpressionAttributeNames: {
            "#data": "data",
            ...(input.updatedAt === undefined ? {} : { "#updatedAt": "updatedAt" }),
          },
          ExpressionAttributeValues: {
            ":data": { S: JSON.stringify(expectedPayload) },
            ...(input.updatedAt === undefined ? {} : { ":updatedAt": { S: input.updatedAt } }),
          },
        }),
      );
      return true;
    } catch (error) {
      const awsError = error as { name?: string };
      if (awsError.name === "ConditionalCheckFailedException") {
        return false;
      }

      throw error;
    }
  }

  private async putEntity<T>(
    pk: string,
    sk: string,
    entityType: EntityType,
    payload: T,
    now: string,
  ): Promise<void> {
    await this.putEntityWithTimestamps(pk, sk, entityType, payload, now, now);
  }

  private async putEntityWithTimestamps<T>(
    pk: string,
    sk: string,
    entityType: EntityType,
    payload: T,
    createdAt: string,
    updatedAt: string,
  ): Promise<void> {
    await this.client.send(
      new PutItemCommand({
        TableName: this.tableName,
        Item: buildItemWithTimestamps(pk, sk, entityType, payload, createdAt, updatedAt),
      }),
    );
  }

  private async repairLegacyGameJoinCode(stored: StoredEntity<unknown>): Promise<GameRecord> {
    let currentStored = stored;

    for (let raceAttempt = 0; raceAttempt < LEGACY_JOIN_CODE_REPAIR_RACE_RETRIES; raceAttempt += 1) {
      const rawGame = currentStored.data as Partial<Omit<GameRecord, "createdAt" | "updatedAt">>;
      const currentGame = normalizeGamePayload(currentStored.data);
      const storedJoinCode =
        typeof rawGame.joinCode === "string" && rawGame.joinCode.trim().length > 0
          ? normalizeJoinCode(rawGame.joinCode)
          : null;
      if (storedJoinCode && JOIN_CODE_PATTERN.test(storedJoinCode)) {
        const joinCodeItem = await this.getEntity(joinCodePk(storedJoinCode), metadataSk(), {
          consistentRead: true,
        });
        if (joinCodeItem?.entityType === ENTITY_TYPE.gameJoinCode) {
          const joinCodeRecord = joinCodeItem.data as Partial<GameJoinCodeRecord>;
          const lookupHasSameGame = joinCodeRecord.gameId === currentGame.gameId;
          const lookupHasSameCode =
            typeof joinCodeRecord.joinCode === "string" &&
            normalizeJoinCode(joinCodeRecord.joinCode) === storedJoinCode;
          if (lookupHasSameGame && lookupHasSameCode) {
            return withTimestamps(
              { ...currentGame, joinCode: storedJoinCode },
              currentStored.createdAt,
              currentStored.updatedAt,
            );
          }
          if (lookupHasSameGame) {
            const repairedGame = await this.writeLegacyGameJoinCodeRepair({
              stored: currentStored,
              game: currentGame,
              joinCode: storedJoinCode,
              joinCodeItem,
            });
            if (repairedGame) {
              return repairedGame;
            }

            break;
          }
        } else if (!joinCodeItem) {
          const repairedGame = await this.writeLegacyGameJoinCodeRepair({
            stored: currentStored,
            game: currentGame,
            joinCode: storedJoinCode,
            joinCodeItem: null,
          });
          if (repairedGame) {
            return repairedGame;
          }

          break;
        }
      }

      const seenCandidates = new Set<string>();
      for (
        let candidateAttempt = 0;
        candidateAttempt < LEGACY_JOIN_CODE_REPAIR_ATTEMPTS;
        candidateAttempt += 1
      ) {
        const joinCode = generateJoinCode();
        if (seenCandidates.has(joinCode)) {
          continue;
        }
        seenCandidates.add(joinCode);

        const joinCodeItem = await this.getEntity(joinCodePk(joinCode), metadataSk(), {
          consistentRead: true,
        });
        if (joinCodeItem?.entityType === ENTITY_TYPE.gameJoinCode) {
          const joinCodeRecord = joinCodeItem.data as Partial<GameJoinCodeRecord>;
          if (joinCodeRecord.gameId !== currentGame.gameId) {
            continue;
          }
        } else if (joinCodeItem) {
          continue;
        }

        const repairedGame = await this.writeLegacyGameJoinCodeRepair({
          stored: currentStored,
          game: currentGame,
          joinCode,
          joinCodeItem: joinCodeItem?.entityType === ENTITY_TYPE.gameJoinCode ? joinCodeItem : null,
        });
        if (repairedGame) {
          return repairedGame;
        }

        break;
      }

      const latest = await this.getEntity(gamePk(currentGame.gameId), metadataSk(), {
        consistentRead: true,
      });
      if (!latest || latest.entityType !== ENTITY_TYPE.game) {
        return withTimestamps(currentGame, currentStored.createdAt, currentStored.updatedAt);
      }
      currentStored = latest;
    }

    throw new GameJoinCodeCollisionError(
      "Could not repair legacy game join code without a collision.",
    );
  }

  private async writeLegacyGameJoinCodeRepair(input: {
    stored: StoredEntity<unknown>;
    game: Omit<GameRecord, "createdAt" | "updatedAt">;
    joinCode: string;
    joinCodeItem: StoredEntity<unknown> | null;
  }): Promise<GameRecord | null> {
    const now = this.clock.now();
    const repairedGame = {
      ...input.game,
      joinCode: input.joinCode,
    };
    const transactionItems: TransactWriteItem[] = [
      this.buildGamePutTransactionItem({
        game: repairedGame,
        stored: input.stored,
        now,
      }),
    ];

    if (input.joinCodeItem) {
      transactionItems.push({
        Put: {
          TableName: this.tableName,
          Item: buildItemWithTimestamps(
            joinCodePk(input.joinCode),
            metadataSk(),
            ENTITY_TYPE.gameJoinCode,
            {
              joinCode: input.joinCode,
              gameId: input.game.gameId,
            },
            input.joinCodeItem.createdAt,
            now,
          ),
          ConditionExpression: "#updatedAt = :expectedJoinCodeUpdatedAt AND #data = :expectedJoinCodeData",
          ExpressionAttributeNames: {
            "#updatedAt": "updatedAt",
            "#data": "data",
          },
          ExpressionAttributeValues: {
            ":expectedJoinCodeUpdatedAt": { S: input.joinCodeItem.updatedAt },
            ":expectedJoinCodeData": { S: input.joinCodeItem.rawData },
          },
        },
      });
    } else {
      transactionItems.push({
        Put: {
          TableName: this.tableName,
          Item: buildItem(
            joinCodePk(input.joinCode),
            metadataSk(),
            ENTITY_TYPE.gameJoinCode,
            {
              joinCode: input.joinCode,
              gameId: input.game.gameId,
            },
            now,
          ),
          ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        },
      });
    }

    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: transactionItems,
        }),
      );
    } catch (error) {
      if (isConditionalWriteFailure(error)) {
        return null;
      }

      throw error;
    }

    return withTimestamps(repairedGame, input.stored.createdAt, now);
  }

  private async readSessionMutationTargets(input: {
    leagueId: string;
    seasonId: string;
    sessionId: string;
  }): Promise<Array<StoredEntity<unknown>>> {
    const [scopedSessionItem, legacySeasonSessionItem, legacySessionMetadataItem, globalSeasonItem] =
      await Promise.all([
        this.getEntity(
          leaguePk(input.leagueId),
          scopedSeasonSessionSk(input.seasonId, input.sessionId),
          { consistentRead: true },
        ),
        this.getEntity(seasonPk(input.seasonId), sessionSk(input.sessionId), {
          consistentRead: true,
        }),
        this.getEntity(sessionPk(input.sessionId), metadataSk(), {
          consistentRead: true,
        }),
        this.getEntity(seasonPk(input.seasonId), metadataSk(), {
          consistentRead: true,
        }),
      ]);
    const isCurrentLegacyOwner = this.isMatchingSeasonEntity(globalSeasonItem, input);
    const legacySessionTargets = [legacySeasonSessionItem, legacySessionMetadataItem].filter(
      (item): item is StoredEntity<unknown> =>
        this.isMatchingSessionEntity(item, input) ||
        (isCurrentLegacyOwner && this.isMatchingLegacySessionEntityWithoutLeague(item, input)),
    );

    return [
      ...[scopedSessionItem].filter((item): item is StoredEntity<unknown> =>
        this.isMatchingSessionEntity(item, input),
      ),
      ...legacySessionTargets,
    ];
  }

  private isMatchingSeasonEntity(
    item: StoredEntity<unknown> | null,
    expected: { leagueId: string; seasonId: string },
  ): item is StoredEntity<unknown> {
    if (!item || item.entityType !== ENTITY_TYPE.season) {
      return false;
    }

    const season = item.data as Partial<SeasonRecord>;
    return season.leagueId === expected.leagueId && season.seasonId === expected.seasonId;
  }

  private isMatchingSessionEntity(
    item: StoredEntity<unknown> | null,
    expected: { leagueId: string; seasonId: string; sessionId: string },
  ): item is StoredEntity<unknown> {
    if (!item || item.entityType !== ENTITY_TYPE.session) {
      return false;
    }

    const session = item.data as Partial<SessionRecord>;
    if (session.seasonId !== expected.seasonId || session.sessionId !== expected.sessionId) {
      return false;
    }

    return session.leagueId === expected.leagueId;
  }

  private isMatchingLegacySessionEntityWithoutLeague(
    item: StoredEntity<unknown> | null,
    expected: { seasonId: string; sessionId: string },
  ): item is StoredEntity<unknown> {
    if (!item || item.entityType !== ENTITY_TYPE.session) {
      return false;
    }

    const session = item.data as Partial<SessionRecord>;
    return (
      session.leagueId === undefined &&
      session.seasonId === expected.seasonId &&
      session.sessionId === expected.sessionId
    );
  }

  private buildLegacySessionCompatibilityPut(input: {
    pk: string;
    sk: string;
    payload: Omit<SessionRecord, "createdAt" | "updatedAt">;
    existing: StoredEntity<unknown> | null;
    expected: { leagueId: string; seasonId: string; sessionId: string };
    allowLegacyWithoutLeague?: boolean;
    now: string;
  }): TransactWriteItem | null {
    if (
      input.existing &&
      !this.isMatchingSessionEntity(input.existing, input.expected) &&
      !(
        input.allowLegacyWithoutLeague === true &&
        this.isMatchingLegacySessionEntityWithoutLeague(input.existing, input.expected)
      )
    ) {
      return null;
    }

    return {
      Put: {
        TableName: this.tableName,
        Item: buildItemWithTimestamps(
          input.pk,
          input.sk,
          ENTITY_TYPE.session,
          input.payload,
          input.existing?.createdAt ?? input.now,
          input.now,
        ),
        ...(input.existing
          ? {
              ConditionExpression: "#updatedAt = :expectedUpdatedAt AND #data = :expectedData",
              ExpressionAttributeNames: {
                "#updatedAt": "updatedAt",
                "#data": "data",
              },
              ExpressionAttributeValues: {
                ":expectedUpdatedAt": { S: input.existing.updatedAt },
                ":expectedData": { S: input.existing.rawData },
              },
            }
          : {
              ConditionExpression: "attribute_not_exists(pk) AND attribute_not_exists(sk)",
            }),
      },
    };
  }

  private async readOwnedLegacySeasonTeamTemplateItems(
    seasonId: string,
    leagueId: string,
  ): Promise<Array<StoredEntity<unknown>>> {
    const result = (await this.client.send(
      new TransactGetItemsCommand({
        TransactItems: [
          {
            Get: {
              TableName: this.tableName,
              Key: {
                pk: { S: leaguePk(leagueId) },
                sk: { S: seasonSk(seasonId) },
              },
            },
          },
          ...TEAM_IDS.map((teamId) => ({
            Get: {
              TableName: this.tableName,
              Key: {
                pk: { S: seasonPk(seasonId) },
                sk: { S: teamSk(teamId) },
              },
            },
          })),
        ],
      }),
    )) as TransactGetItemsCommandOutput;

    const responses = result.Responses ?? [];
    const seasonItem = responses[0]?.Item;
    if (!seasonItem) {
      return [];
    }

    const season = parseStoredEntity<Partial<SeasonRecord>>(seasonItem);
    if (!this.isMatchingSeasonEntity(season, { leagueId, seasonId })) {
      return [];
    }

    return responses
      .slice(1)
      .flatMap((response) => (response.Item ? [parseStoredEntity(response.Item)] : []))
      .filter((item): item is StoredEntity<unknown> =>
        this.isMatchingSeasonTeamEntity(item, { seasonId, leagueId }),
      );
  }

  private isMatchingSeasonTeamEntity(
    item: StoredEntity<unknown> | null,
    expected: { seasonId: string; leagueId?: string },
  ): item is StoredEntity<unknown> {
    if (!item || item.entityType !== ENTITY_TYPE.team) {
      return false;
    }

    const team = item.data as Partial<TeamRecord>;
    if (team.seasonId !== expected.seasonId || !TEAM_IDS.includes(team.teamId as TeamId)) {
      return false;
    }

    return expected.leagueId === undefined || team.leagueId === expected.leagueId;
  }

  private buildConditionalPutFromStoredEntity(
    stored: StoredEntity<unknown>,
    now: string,
  ): TransactWriteItem {
    return {
      Put: {
        TableName: this.tableName,
        Item: buildItemWithTimestamps(
          stored.pk,
          stored.sk,
          stored.entityType,
          stored.data,
          stored.createdAt,
          now,
        ),
        ConditionExpression: "#updatedAt = :expectedUpdatedAt AND #data = :expectedData",
        ExpressionAttributeNames: {
          "#updatedAt": "updatedAt",
          "#data": "data",
        },
        ExpressionAttributeValues: {
          ":expectedUpdatedAt": { S: stored.updatedAt },
          ":expectedData": { S: stored.rawData },
        },
      },
    };
  }

  private buildConditionalCheckFromStoredEntity(stored: StoredEntity<unknown>): TransactWriteItem {
    return {
      ConditionCheck: {
        TableName: this.tableName,
        Key: {
          pk: { S: stored.pk },
          sk: { S: stored.sk },
        },
        ConditionExpression: "#updatedAt = :expectedUpdatedAt AND #data = :expectedData",
        ExpressionAttributeNames: {
          "#updatedAt": "updatedAt",
          "#data": "data",
        },
        ExpressionAttributeValues: {
          ":expectedUpdatedAt": { S: stored.updatedAt },
          ":expectedData": { S: stored.rawData },
        },
      },
    };
  }

  private buildConditionalDeleteFromStoredEntity(stored: StoredEntity<unknown>): TransactWriteItem {
    return {
      Delete: {
        TableName: this.tableName,
        Key: {
          pk: { S: stored.pk },
          sk: { S: stored.sk },
        },
        ConditionExpression: "#updatedAt = :expectedUpdatedAt AND #data = :expectedData",
        ExpressionAttributeNames: {
          "#updatedAt": "updatedAt",
          "#data": "data",
        },
        ExpressionAttributeValues: {
          ":expectedUpdatedAt": { S: stored.updatedAt },
          ":expectedData": { S: stored.rawData },
        },
      },
    };
  }

  private async deleteSessionTargetsIfUnchanged(
    targets: Array<StoredEntity<unknown>>,
  ): Promise<void> {
    const uniqueTargets = [
      ...new Map(targets.map((target) => [`${target.pk}|${target.sk}`, target])).values(),
    ];
    if (uniqueTargets.length === 0) {
      return;
    }

    try {
      await this.client.send(
        new TransactWriteItemsCommand({
          TransactItems: uniqueTargets.map((target) =>
            this.buildConditionalDeleteFromStoredEntity(target),
          ),
        }),
      );
    } catch (error) {
      if (isConditionalWriteFailure(error)) {
        return;
      }

      throw error;
    }
  }

  private async putEntityWithTimestampsIfUnchanged<T>(
    pk: string,
    sk: string,
    entityType: EntityType,
    payload: T,
    createdAt: string,
    updatedAt: string,
    expected: { updatedAt: string; rawData: string },
  ): Promise<boolean> {
    try {
      await this.client.send(
        new PutItemCommand({
          TableName: this.tableName,
          Item: buildItemWithTimestamps(pk, sk, entityType, payload, createdAt, updatedAt),
          ConditionExpression: "#updatedAt = :expectedUpdatedAt AND #data = :expectedData",
          ExpressionAttributeNames: {
            "#updatedAt": "updatedAt",
            "#data": "data",
          },
          ExpressionAttributeValues: {
            ":expectedUpdatedAt": { S: expected.updatedAt },
            ":expectedData": { S: expected.rawData },
          },
        }),
      );
      return true;
    } catch (error) {
      const awsError = error as { name?: string };
      if (awsError.name === "ConditionalCheckFailedException") {
        return false;
      }

      throw error;
    }
  }

  private async deleteEntity(pk: string, sk: string): Promise<void> {
    await this.client.send(
      new DeleteItemCommand({
        TableName: this.tableName,
        Key: {
          pk: { S: pk },
          sk: { S: sk },
        },
      }),
    );
  }

  private async getEntity(
    pk: string,
    sk: string,
    options: { consistentRead?: boolean } = {},
  ): Promise<StoredEntity<unknown> | null> {
    const result = (await this.client.send(
      new GetItemCommand({
        TableName: this.tableName,
        Key: {
          pk: { S: pk },
          sk: { S: sk },
        },
        ConsistentRead: options.consistentRead,
      }),
    )) as GetItemCommandOutput;

    if (!result.Item) {
      return null;
    }

    return parseStoredEntity(result.Item);
  }

  // Opt-in only for the complete roster read; existing query consumers retain
  // their behaviour. Read pages serially and never silently return a partial list.
  private async queryCompleteGameRoster(
    gameId: string,
    skPrefix: "PLAYER#" | "ROSTER#",
    options: QueryByPrefixOptions,
  ): Promise<Array<StoredEntity<unknown>>> {
    const items: Array<StoredEntity<unknown>> = [];
    let cursor: Record<string, AttributeValue> | undefined;
    const seen = new Set<string>();
    do {
      const result = (await this.client.send(new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk and begins_with(sk, :skPrefix)",
        ConsistentRead: options.consistentRead,
        ExpressionAttributeValues: { ":pk": { S: gamePk(gameId) }, ":skPrefix": { S: skPrefix } },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }))) as QueryCommandOutput;
      items.push(...(result.Items ?? []).map((item) => parseStoredEntity(item)));
      cursor = result.LastEvaluatedKey;
      if (cursor && Object.keys(cursor).length === 0) cursor = undefined;
      if (cursor) {
        const key = JSON.stringify([cursor.pk?.S, cursor.sk?.S]);
        if (cursor.pk?.S !== gamePk(gameId) || !cursor.sk?.S?.startsWith(skPrefix) || seen.has(key)) {
          throw new Error("Roster continuation could not be confirmed.");
        }
        seen.add(key);
      }
    } while (cursor);
    return items;
  }

  private async queryByPrefix(
    pk: string,
    skPrefix: string,
    options: QueryByPrefixOptions = {},
  ): Promise<Array<StoredEntity<unknown>>> {
    const result = (await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk and begins_with(sk, :skPrefix)",
        ConsistentRead: options.consistentRead,
        ExpressionAttributeValues: {
          ":pk": { S: pk },
          ":skPrefix": { S: skPrefix },
        },
      }),
    )) as QueryCommandOutput;

    return (result.Items ?? []).map((item) => parseStoredEntity(item));
  }
}
