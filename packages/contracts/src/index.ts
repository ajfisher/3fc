export type TeamId = "red" | "blue" | "yellow";
export type ThirdNumber = 1 | 2 | 3;
export type ThirdLengthMinutes = 20 | 25 | 30;
export type ThirdTimerStatus = "not_started" | "running" | "finished";
export type GameTimerStatus = "not_started" | "running" | "between_thirds" | "complete";

export const TEAM_IDS = ["red", "blue", "yellow"] as const satisfies readonly TeamId[];
export const THIRD_NUMBERS = [1, 2, 3] as const satisfies readonly ThirdNumber[];
export const THIRD_LENGTH_MINUTES = [20, 25, 30] as const satisfies readonly ThirdLengthMinutes[];
export const DEFAULT_THIRD_LENGTH_MINUTES = 20 satisfies ThirdLengthMinutes;

export interface DefaultTeamDefinition {
  teamId: TeamId;
  name: string;
  color: string;
}

export const DEFAULT_TEAMS = [
  {
    teamId: "red",
    name: "Red",
    color: "#d83b36",
  },
  {
    teamId: "blue",
    name: "Blue",
    color: "#2364d2",
  },
  {
    teamId: "yellow",
    name: "Yellow",
    color: "#e0a612",
  },
] as const satisfies readonly DefaultTeamDefinition[];

export interface GoalEventInput {
  gameId: string;
  scoringTeamId: TeamId | null;
  concedingTeamId: TeamId;
  scorerPlayerId: string;
  assistPlayerIds: string[];
  ownGoal: boolean;
}

export interface GoalEvent {
  gameId: string;
  eventId: string;
  third: ThirdNumber;
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

export interface GameScoreboardTeam {
  gameId: string;
  teamId: TeamId;
  name: string;
  color: string | null;
  scored: number;
  conceded: number;
  createdAt: string;
  updatedAt: string;
}

export interface GameScoreboard {
  teams: GameScoreboardTeam[];
}

export interface CreateGoalResponse {
  goal: GoalEvent;
  scoreboard: GameScoreboard;
  timeline: GoalEvent[];
}

export interface ThirdTimerSegment {
  third: ThirdNumber;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ThirdTimerState extends ThirdTimerSegment {
  status: ThirdTimerStatus;
}

export interface GameTimerState {
  thirdLengthMinutes: ThirdLengthMinutes;
  activeThird: ThirdNumber | null;
  status: GameTimerStatus;
  thirds: ThirdTimerState[];
}

export interface ThirdDisplayTime {
  displayTime: string;
  phase: "regulation" | "stoppage";
  elapsedSeconds: number;
  stoppageSeconds: number;
  stoppageMinute: number | null;
}

export interface GameHealth {
  status: "ok";
  service: "api";
  version: string;
  timestamp: string;
}

export const MAX_ASSISTS = 3;

export function isThirdNumber(value: number): value is ThirdNumber {
  return THIRD_NUMBERS.includes(value as ThirdNumber);
}

export function isThirdLengthMinutes(value: number): value is ThirdLengthMinutes {
  return THIRD_LENGTH_MINUTES.includes(value as ThirdLengthMinutes);
}

export function createDefaultThirdTimerSegments(): ThirdTimerSegment[] {
  return THIRD_NUMBERS.map((third) => ({
    third,
    startedAt: null,
    finishedAt: null,
  }));
}

export function buildGameTimerState(input: {
  thirdLengthMinutes: ThirdLengthMinutes;
  thirds: readonly ThirdTimerSegment[];
}): GameTimerState {
  const thirdsByNumber = new Map(input.thirds.map((third) => [third.third, third]));
  const thirds = THIRD_NUMBERS.map((third) => {
    const segment = thirdsByNumber.get(third) ?? {
      third,
      startedAt: null,
      finishedAt: null,
    };
    const status: ThirdTimerStatus = segment.finishedAt
      ? "finished"
      : segment.startedAt
        ? "running"
        : "not_started";

    return {
      third,
      startedAt: segment.startedAt,
      finishedAt: segment.finishedAt,
      status,
    };
  });
  const activeThird = thirds.find((third) => third.status === "running")?.third ?? null;
  const anyStarted = thirds.some((third) => third.startedAt !== null);
  const allFinished = thirds.every((third) => third.status === "finished");
  const status: GameTimerStatus = activeThird
    ? "running"
    : allFinished
      ? "complete"
      : anyStarted
        ? "between_thirds"
        : "not_started";

  return {
    thirdLengthMinutes: input.thirdLengthMinutes,
    activeThird,
    status,
    thirds,
  };
}

function padTwoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatThirdDisplayTime(
  elapsedSeconds: number,
  thirdLengthMinutes: ThirdLengthMinutes,
): ThirdDisplayTime {
  const safeElapsedSeconds = Math.max(0, Math.floor(elapsedSeconds));
  const nominalSeconds = thirdLengthMinutes * 60;

  if (safeElapsedSeconds < nominalSeconds) {
    const minutes = Math.floor(safeElapsedSeconds / 60);
    const seconds = safeElapsedSeconds % 60;
    return {
      displayTime: `${padTwoDigits(minutes)}:${padTwoDigits(seconds)}`,
      phase: "regulation",
      elapsedSeconds: safeElapsedSeconds,
      stoppageSeconds: 0,
      stoppageMinute: null,
    };
  }

  const stoppageSeconds = safeElapsedSeconds - nominalSeconds;
  const stoppageMinute = Math.floor(stoppageSeconds / 60) + 1;
  return {
    displayTime: `${thirdLengthMinutes}+${padTwoDigits(stoppageMinute)}`,
    phase: "stoppage",
    elapsedSeconds: safeElapsedSeconds,
    stoppageSeconds,
    stoppageMinute,
  };
}

export function validateAssistPlayerIds(
  scorerPlayerId: string,
  assistPlayerIds: string[],
): void {
  const uniqueAssistIds = new Set(assistPlayerIds);

  if (assistPlayerIds.length > MAX_ASSISTS) {
    throw new Error(`No more than ${MAX_ASSISTS} assists are allowed.`);
  }

  if (uniqueAssistIds.size !== assistPlayerIds.length) {
    throw new Error("Assist player IDs must be unique.");
  }

  if (uniqueAssistIds.has(scorerPlayerId)) {
    throw new Error("Scorer cannot be listed as an assister.");
  }
}
