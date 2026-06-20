import { z } from "zod";
import { MAX_ASSISTS, TEAM_IDS, THIRD_LENGTH_MINUTES } from "@3fc/contracts";

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
    status: z.enum(["scheduled", "live"]).optional(),
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

export const joinGameRequestSchema = z
  .object({
    nickname: nonEmptyTrimmedString,
  })
  .strict();

export const assignRosterPlayerRequestSchema = z
  .object({
    teamId: teamIdSchema,
  })
  .strict();

export const createGoalRequestSchema = z
  .object({
    scoringTeamId: teamIdSchema.nullable(),
    concedingTeamId: teamIdSchema,
    scorerPlayerId: nonEmptyTrimmedString,
    assistPlayerIds: z
      .array(nonEmptyTrimmedString)
      .max(MAX_ASSISTS, `must contain no more than ${MAX_ASSISTS} player IDs`)
      .optional()
      .default([]),
    ownGoal: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    const assistPlayerIds = value.assistPlayerIds;
    const uniqueAssistPlayerIds = new Set(assistPlayerIds);

    if (uniqueAssistPlayerIds.size !== assistPlayerIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assistPlayerIds"],
        message: "must be unique",
      });
    }

    if (uniqueAssistPlayerIds.has(value.scorerPlayerId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assistPlayerIds"],
        message: "must not include the scorer",
      });
    }

    if (value.ownGoal && value.scoringTeamId !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scoringTeamId"],
        message: "must be null for own goals",
      });
    }

    if (!value.ownGoal && value.scoringTeamId === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["scoringTeamId"],
        message: "is required for standard goals",
      });
    }

    if (!value.ownGoal && value.scoringTeamId === value.concedingTeamId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["concedingTeamId"],
        message: "must differ from scoringTeamId for standard goals",
      });
    }
  });

export const updateGoalRequestSchema = z
  .object({
    scoringTeamId: teamIdSchema.nullable().optional(),
    concedingTeamId: teamIdSchema.optional(),
    scorerPlayerId: nonEmptyTrimmedString.optional(),
    assistPlayerIds: z
      .array(nonEmptyTrimmedString)
      .max(MAX_ASSISTS, `must contain no more than ${MAX_ASSISTS} player IDs`)
      .optional(),
    ownGoal: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.scoringTeamId === undefined &&
      value.concedingTeamId === undefined &&
      value.scorerPlayerId === undefined &&
      value.assistPlayerIds === undefined &&
      value.ownGoal === undefined
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must include at least one goal field to update",
      });
    }

    if (value.assistPlayerIds !== undefined) {
      const uniqueAssistPlayerIds = new Set(value.assistPlayerIds);

      if (uniqueAssistPlayerIds.size !== value.assistPlayerIds.length) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["assistPlayerIds"],
          message: "must be unique",
        });
      }

      if (
        value.scorerPlayerId !== undefined &&
        uniqueAssistPlayerIds.has(value.scorerPlayerId)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["assistPlayerIds"],
          message: "must not include the scorer",
        });
      }
    }
  });

export const undoLastGoalRequestSchema = z
  .object({
    expectedEventId: nonEmptyTrimmedString,
  })
  .strict();

export type CreateLeagueRequest = z.infer<typeof createLeagueRequestSchema>;
export type CreateSeasonRequest = z.infer<typeof createSeasonRequestSchema>;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type CreateGameRequest = z.infer<typeof createGameRequestSchema>;
export type UpsertTeamRequest = z.infer<typeof upsertTeamRequestSchema>;
export type QuickCreateGamePlayerRequest = z.infer<typeof quickCreateGamePlayerRequestSchema>;
export type JoinGameRequest = z.infer<typeof joinGameRequestSchema>;
export type AssignRosterPlayerRequest = z.infer<typeof assignRosterPlayerRequestSchema>;
export type CreateGoalRequest = z.infer<typeof createGoalRequestSchema>;
export type UpdateGoalRequest = z.infer<typeof updateGoalRequestSchema>;
export type UndoLastGoalRequest = z.infer<typeof undoLastGoalRequestSchema>;

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
