export type TeamId = "red" | "blue" | "yellow";

export const TEAM_IDS = ["red", "blue", "yellow"] as const satisfies readonly TeamId[];

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
  third: 1 | 2 | 3;
  scoringTeamId: TeamId | null;
  concedingTeamId: TeamId;
  scorerPlayerId: string;
  assistPlayerIds: string[];
  ownGoal: boolean;
}

export interface GameHealth {
  status: "ok";
  service: "api";
  version: string;
  timestamp: string;
}

export const MAX_ASSISTS = 3;

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
