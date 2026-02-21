export type TeamId = "red" | "blue" | "yellow";

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
