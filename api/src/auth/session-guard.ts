import { getCookieValue } from "./http-security.js";
import type { AuthSessionRecord } from "./magic-link.js";

export interface SessionLookup {
  getSession(sessionId: string): Promise<AuthSessionRecord | null>;
}

export type SessionGuardFailureCode = "missing_cookie" | "invalid_session";

export interface SessionGuardResult {
  session: AuthSessionRecord | null;
  failure: SessionGuardFailureCode | null;
}

export async function resolveSessionFromCookie(
  cookieHeader: string | undefined,
  cookieName: string,
  sessionLookup: SessionLookup,
): Promise<SessionGuardResult> {
  const sessionId = getCookieValue(cookieHeader, cookieName);

  if (!sessionId) {
    return {
      session: null,
      failure: "missing_cookie",
    };
  }

  const session = await sessionLookup.getSession(sessionId);

  if (!session) {
    return {
      session: null,
      failure: "invalid_session",
    };
  }

  return {
    session,
    failure: null,
  };
}
