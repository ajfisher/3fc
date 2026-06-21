import { z } from "zod";
import { TEAM_IDS, THIRD_LENGTH_MINUTES } from "@3fc/contracts";

const nonEmptyTrimmedString = z.string().trim().min(1, "must be a non-empty string");
const optionalNullableString = z.string().nullable().optional();
const teamIdSchema = z.enum(TEAM_IDS);
const thirdLengthMinutesSchema = z.union([
  z.literal(THIRD_LENGTH_MINUTES[0]),
  z.literal(THIRD_LENGTH_MINUTES[1]),
  z.literal(THIRD_LENGTH_MINUTES[2]),
]);

export const idempotencyKeyHeaderSchema = z
  .string()
  .trim()
  .min(1, "must be a non-empty string")
  .max(128, "must be 128 characters or fewer");

export const createLeagueRequestSchema = z
  .object({
    leagueId: nonEmptyTrimmedString,
    name: nonEmptyTrimmedString,
    slug: optionalNullableString,
  })
  .strict();

export const createSeasonRequestSchema = z
  .object({
    seasonId: nonEmptyTrimmedString,
    name: nonEmptyTrimmedString,
    slug: optionalNullableString,
    startsOn: optionalNullableString,
    endsOn: optionalNullableString,
  })
  .strict();

export const createSessionRequestSchema = z
  .object({
    sessionId: nonEmptyTrimmedString,
    sessionDate: nonEmptyTrimmedString,
  })
  .strict();

export const createGameRequestSchema = z
  .object({
    gameId: nonEmptyTrimmedString,
    gameStartTs: nonEmptyTrimmedString,
    status: z.enum(["scheduled", "live", "finished"]).optional(),
    thirdLengthMinutes: thirdLengthMinutesSchema.optional(),
  })
  .strict();

export const upsertTeamRequestSchema = z
  .object({
    name: nonEmptyTrimmedString,
    color: optionalNullableString,
  })
  .strict();

export const quickCreateGamePlayerRequestSchema = z
  .object({
    playerId: nonEmptyTrimmedString.optional(),
    nickname: nonEmptyTrimmedString,
  })
  .strict();

export const assignRosterPlayerRequestSchema = z
  .object({
    teamId: teamIdSchema,
  })
  .strict();

export type CreateLeagueRequest = z.infer<typeof createLeagueRequestSchema>;
export type CreateSeasonRequest = z.infer<typeof createSeasonRequestSchema>;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type CreateGameRequest = z.infer<typeof createGameRequestSchema>;
export type UpsertTeamRequest = z.infer<typeof upsertTeamRequestSchema>;
export type QuickCreateGamePlayerRequest = z.infer<typeof quickCreateGamePlayerRequestSchema>;
export type AssignRosterPlayerRequest = z.infer<typeof assignRosterPlayerRequestSchema>;

export function formatSchemaValidationError(error: z.ZodError): string {
  if (error.issues.length === 0) {
    return "Request body failed validation.";
  }

  return error.issues
    .map((issue) => {
      if (issue.path.length === 0) {
        return issue.message;
      }

      return `Field \`${issue.path.join(".")}\` ${issue.message}.`;
    })
    .join(" ");
}
