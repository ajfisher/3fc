import type { AuthSessionRecord } from "./auth/magic-link.js";
import { homeLeaguePageSchema, type HomeLeaguePage } from "./data/home-league-read.js";
import { PlayerIdentityError } from "./data/player-identity.js";
export interface HomeLeagueRepository {
  listHomeLeagues?(input: { userIds: readonly string[]; cursor?: string }): Promise<HomeLeaguePage | null>;
}
// Shared by Lambda and the local server. Only verified session identifiers reach
// the reader; query parameters contain pagination state, never account identity.
export async function handleHomeLeaguePage(input: { rawQueryString: string; session: AuthSessionRecord | null;
  repository: HomeLeagueRepository }): Promise<{ statusCode: number; payload: Record<string, unknown> } | null> {
  if (!input.rawQueryString) return null;
  const error = (statusCode: number, code: string, message: string) => ({ statusCode, payload: { error: statusCode === 400 ? "bad_request" : statusCode === 401 ? "unauthorized" : "service_unavailable", code, message } });
  if (!input.session) return error(401, "missing_session", "Sign in to continue.");
  let cursor: string | undefined;
  try {
    if (input.rawQueryString.length > 12_000) throw new Error();
    decodeURIComponent(input.rawQueryString.replaceAll('+', ' '));
    const fields = new URLSearchParams(input.rawQueryString);
    if (fields.getAll("page").length !== 1 || fields.get("page") !== "1" || fields.getAll("cursor").length > 1 ||
      [...fields.keys()].some(key => !["page", "cursor"].includes(key))) throw new Error();
    cursor = fields.get("cursor") ?? undefined;
    if (cursor !== undefined && (!cursor || cursor.length > 8192)) throw new Error();
  } catch { return error(400, "home_cursor_invalid", "Refresh the league list and try again."); }
  if (!input.repository.listHomeLeagues) return null;
  try {
    const value = await input.repository.listHomeLeagues({ userIds: [...new Set([input.session.subject ?? input.session.email, input.session.email])], cursor });
    if (value === null) return null;
    const payload = homeLeaguePageSchema.parse(value);
    if (payload.complete !== (payload.cursor === null) || (payload.hasManagementAccess === false && !payload.complete)) throw new Error();
    return { statusCode: 200, payload };
  } catch (cause) {
    if (cause instanceof PlayerIdentityError) return error(cause.status, cause.code, cause.message);
    return error(503, "home_lookup_unavailable", "League navigation is temporarily unavailable. Try again.");
  }
}
