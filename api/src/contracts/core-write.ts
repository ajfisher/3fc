import { z } from "zod";

const nonEmptyTrimmedString = z.string().trim().min(1, "must be a non-empty string");
const optionalNullableString = z.string().nullable().optional();

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
  })
  .strict();

export type CreateLeagueRequest = z.infer<typeof createLeagueRequestSchema>;
export type CreateSeasonRequest = z.infer<typeof createSeasonRequestSchema>;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type CreateGameRequest = z.infer<typeof createGameRequestSchema>;

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
