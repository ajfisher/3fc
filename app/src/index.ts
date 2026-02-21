import type { TeamId } from "@3fc/contracts";

const DEFAULT_TEAMS: TeamId[] = ["red", "blue", "yellow"];

export function getDefaultTeams(): TeamId[] {
  return DEFAULT_TEAMS;
}
